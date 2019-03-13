import buildApplication, {
  BaseApplicationConfig,
  StateMachine,
  Application
} from 'lotion-state-machine'

import { join } from 'path'
import { homedir } from 'os'
import createABCIServer, { ABCIServer } from './abci-server'
import createTendermintProcess from './tendermint'
import createDiscoveryServer, { DiscoveryServer } from './discovery'
import { randomBytes, createHash } from 'crypto'
import fs = require('fs-extra')
import getPort = require('get-port')

import TxServer = require('./tx-server')


interface ApplicationConfig extends BaseApplicationConfig {
  rpcPort?: number
  p2pPort?: number
  abciPort?: number
  lotionPort?: number
  logTendermint?: boolean
  tmConfig?: any
  keyPath?: string
  genesisPath?: string
  peers?: Array<string>
  discovery?: boolean
}

interface PortMap {
  abci: number
  p2p: number
  rpc: number
  lotion: number
}

interface AppInfo {
  ports: PortMap
  GCI: string
  genesisPath: string
}

export class LotionApp implements Application {
  private stateMachine: StateMachine
  private application: Application
  private abciServer: ABCIServer
  private discoveryServer: DiscoveryServer
  private tendermintProcess
  private ports: PortMap
  private genesis: string
  private peers: Array<string>
  private genesisPath: string
  private keyPath: string
  private initialState: object
  private logTendermint: boolean
  private tmConfig: any
  private discovery: boolean = true
  private home: string
  private lotionHome: string = join(homedir(), '.lotion', 'networks')
  private txServer: any
  private txHTTPServer: any

  public use
  public useTx
  public useBlock
  public useQuery
  public useInitializer
  public GCI

  constructor(private config: ApplicationConfig) {
    this.application = buildApplication(config)
    this.logTendermint = config.logTendermint
    this.tmConfig = config.tmConfig
    this.initialState = config.initialState
    this.keyPath = config.keyPath
    this.genesisPath = config.genesisPath
    this.peers = config.peers
    this.discovery = config.discovery == null ? true : config.discovery

    this.setHome()
    Object.assign(this, this.application)
  }

  private async assignPorts() {
    this.ports = {
      abci: this.config.abciPort || (await getPort()),
      p2p: this.config.p2pPort || (await getPort()),
      rpc: this.config.rpcPort || (await getPort()),
      lotion: this.config.lotionPort || (await getPort())
    }
  }

  private setGCI() {
    this.GCI = createHash('sha256')
      .update(this.genesis)
      .digest('hex')
  }

  private getAppInfo(): AppInfo {
    return {
      ports: this.ports,
      GCI: this.GCI,
      genesisPath: this.genesisPath
    }
  }

  private setGenesis() {
    if (!this.genesisPath) {
      this.genesisPath = join(this.home, 'config', 'genesis.json')
    }
    this.genesis = fs.readFileSync(this.genesisPath, 'utf8')
  }

  private setHome() {
    /**
     * if genesisPath or keyPath is provided,
     * home path is hash(genesisPath, keyPath)
     *
     * otherwise a random id is generated.
     */
    let homePath = createHash('sha256')
    if (this.config.genesisPath) {
      homePath.update(fs.readFileSync(this.config.genesisPath))
    }
    if (this.config.keyPath) {
      homePath.update(fs.readFileSync(this.config.keyPath))
    }

    if (!this.config.genesisPath && !this.config.keyPath) {
      homePath.update(randomBytes(16).toString('hex'))
    }

    this.home = join(this.lotionHome, homePath.digest('hex'))
  }

  async start() {
    await this.assignPorts()
    await fs.mkdirp(this.home)

    // start state machine
    this.stateMachine = this.application.compile()

    this.abciServer = createABCIServer(
      this.stateMachine,
      this.initialState,
      this.home
    )
    this.abciServer.listen(this.ports.abci)

    // start tendermint process
    this.tendermintProcess = await createTendermintProcess({
      ports: this.ports,
      home: this.home,
      logTendermint: this.logTendermint,
      tmConfig: this.tmConfig,
      keyPath: this.keyPath,
      genesisPath: this.genesisPath,
      peers: this.peers
    })

    this.setGenesis()
    this.setGCI()

    // start discovery server
    if (this.discovery) {
      this.discoveryServer = createDiscoveryServer({
        GCI: this.GCI,
        genesis: this.genesis,
        rpcPort: this.ports.rpc
      })
    }
    this.txServer = TxServer({
      port: this.ports.lotion,
      rpcPort: this.ports.rpc,
      stateMachine: this.stateMachine
    })
    this.txHTTPServer = this.txServer.listen(this.ports.lotion, 'localhost', function() {
      console.log("listening...")
    })

    let appInfo = this.getAppInfo()

    return appInfo
  }
}

let Lotion: any = function(config) {
  return new LotionApp(config)
}

Lotion.connect = require('lotion-connect')
export { Lotion }
