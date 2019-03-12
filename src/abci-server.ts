import djson = require('deterministic-json')
import vstruct = require('varstruct')
import { createHash } from 'crypto'

let to = require('await-to-js').to
import jsondiffpatch = require('jsondiffpatch')
let fs = require('fs-extra')
let { join } = require('path')

let createServer = require('abci')
let { createHash } = require('crypto')
let fs = require('fs-extra')
let { join } = require('path')

export interface ABCIServer {
  listen(port)
}

export default function createABCIServer(
  stateMachine,
  initialState,
  lotionAppHome
): any {
  let stateFilePath = join(lotionAppHome, 'prev-state.json')
  let height = 0

  let abciServer = createServer({
    async info(request) {
      let stateFileExists = await fs.pathExists(stateFilePath)
      if (stateFileExists) {
        let stateFile = djson.parse(await fs.readFile(stateFilePath, 'utf8'))
        let rootHash = createHash('sha256')
          .update(djson.stringify(stateFile.state))
          .digest()

        stateMachine.initialize(stateFile.state, stateFile.context, true)
        height = stateFile.height
        return {
          lastBlockAppHash: rootHash,
          lastBlockHeight: stateFile.height
        }
      } else {
        return {}
      }
    },

    deliverTx(request) {
      try {
        let tx = decodeTx(request.tx)
        try {
          stateMachine.transition({ type: 'transaction', data: tx })
          return {}
        } catch (e) {
          return { code: 1, log: e.toString() }
        }
      } catch (e) {
        return { code: 1, log: 'Invalid transaction encoding' }
      }
    },

    checkTx(request) {
      try {
        let tx = decodeTx(request.tx)
        try {
          stateMachine.check(tx)
          return {}
        } catch (e) {
          return { code: 1, log: e.toString() }
        }
      } catch (e) {
        return { code: 1, log: 'Invalid transaction encoding' }
      }
    },

    beginBlock(request) {
      let block = request.header
      let time = request.header.time.seconds.toNumber()
      stateMachine.transition({ type: 'begin-block', data: { time } })

      stateMachine.transition({ type: 'begin-block', data: { time, block, height } })
      return {}
    },

    endBlock() {
      stateMachine.transition({ type: 'block', data: {} })
      let { validators } = stateMachine.context()
      let validatorUpdates = []

      for (let pubKey in validators) {
        validatorUpdates.push({
          pubKey: { type: 'ed25519', data: Buffer.from(pubKey, 'base64') },
          power: { low: validators[pubKey], high: 0 }
        })
      }
      return {
        validatorUpdates
      }
    },
    async commit() {
      let data = stateMachine.commit()
      let state = stateMachine.query()

      let newStateFilePath = join(lotionAppHome, `state.json`)
      if (await fs.pathExists(newStateFilePath)) {
        await fs.move(newStateFilePath, stateFilePath, { overwrite: true })
      }

      let context = Object.assign({}, stateMachine.context())
      delete context.rootState
      await fs.writeFile(
        newStateFilePath,
        djson.stringify({
          context,
          state,
          height
        })
      )


      // Build diff from last state and update diffDB
      let stateFileExists = await fs.pathExists(stateFilePath)
      if (stateFileExists) {
        let stateFile = djson.parse(await fs.readFile(stateFilePath, 'utf8'))
        let diff = jsondiffpatch.diff(stateFile.state, state)
        if (diff) {
          let [err, response] = await to(diffDb.put(height, djson.stringify(diff)))
          if (err) console.log("Error saving diff.")
        }
      }


      return { data: Buffer.from(data, 'hex') }
    },

    initChain(request) {
      /**
       * in next abci version, we'll get a timestamp here.
       * height is no longer tracked on info (we want to encourage isomorphic chain/channel code)
       */
      let initialInfo = buildInitialInfo(request)
      stateMachine.initialize(initialState, initialInfo)
      return {}
    },

    async query(req) {
      // Helper functions
      let pathInObject = function(obj, path='') {
        let args = path.split('.')
        for (var i = 0; i < args.length; i++) {
          if (!obj.hasOwnProperty(args[i])) {
            return false
          }
          obj = obj[args[i]]
        }
        return true
      }

      let resolve = function(obj, path='') {
        let args = path.split('.')
        var current = obj
        while(args.length) {
          if(typeof current !== 'object') return undefined
          current = current[args.shift()]
        }
        return current
      }


      let data = ''
      if (req.data) {
        try {
          data = Buffer.from(req.data, 'base64').toString()
        }
        catch (error) {
          console.log(error)
        }
      }

      if (data=="diff") {
        req.height = (req.height!=0) ? req.height : (height - 1)
        let [err, response] = await to(diffDb.get(req.height))
        if (err) {
          if (err.notFound) {
            return { code: "3", log: 'diff not found' }
          } else {
            return { code: "2", log: 'invalid query: '+err.message }
          }
        } else {
          response = djson.parse(response)
          if (pathInObject(response, req.path)) {
            response = resolve(response, req.path)
          } else {
            req.path = '*'
          }

          return {
            value: Buffer.from(djson.stringify(response)).toString('base64'),
            height: `${req.height}`,
            code: "0",
            log: `path: '${req.path}', block: ${req.height}, data:${data}`
          }
        }
      } else {
        try {
          let state = stateMachine.query()
          req.height = height - 1
          let response = state

          if (pathInObject(state, req.path)) {
            response = resolve(state, req.path)
          } else {
            req.path = '*'
          }

          return {
            value: Buffer.from(djson.stringify(response)).toString('base64'),
            height: `${req.height}`,
            code: "0",
            log: `path: '${req.path}', block: ${req.height}`
          }
        } catch (err) {
          if (err.notFound) {
            return { code: "3", log: 'state not found' }
          } else {
            return { code: "2", log: 'invalid query: '+err.message }
          }
        }
      }
    }
  })

  return abciServer
}

function buildInitialInfo(initChainRequest) {
  let result = {
    validators: {}
  }
  initChainRequest.validators.forEach(validator => {
    result.validators[
      validator.pubKey.data.toString('base64')
    ] = validator.power.toNumber()
  })

  return result
}

let TxStruct = vstruct([
  { name: 'data', type: vstruct.VarString(vstruct.UInt32BE) },
  { name: 'nonce', type: vstruct.UInt32BE }
])

function decodeTx(txBuffer) {
  let decoded = TxStruct.decode(txBuffer)
  let tx = djson.parse(decoded.data)
  return tx
}
