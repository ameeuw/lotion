import express = require('express');
import { json } from 'body-parser';
import proxy = require('express-http-proxy');
import cors = require('cors');
import { to } from 'await-to-js';
import axios from 'axios'
import { StateMachine } from 'lotion-state-machine';
let vstruct = require('varstruct')
let { stringify, parse } = require('deterministic-json')

let TxStruct = vstruct([
  { name: 'data', type: vstruct.VarString(vstruct.UInt32BE) },
  { name: 'nonce', type: vstruct.UInt32BE }
])

function decode(txBuffer) {
  let decoded = TxStruct.decode(txBuffer)
  let tx = parse(decoded.data)
  return tx
}

function encode(txData, nonce) {
  let data = stringify(txData)
  let bytes = TxStruct.encode({ nonce, data })
  return bytes
}

export function TxServer(
  rpcPort: number,
  stateMachine: StateMachine
) {
  let app: express.Application = express()
  app.use(cors())
  app.use(json({ type: '*/*' }))
  app.post('/txs', async (req, res) => {
    // encode transaction bytes, send it to tendermint node
    let nonce = Math.floor(Math.random() * (2 << 12))
    let txBytes = '0x' + encode(req.body, nonce).toString('hex')
    let result = await axios.get(`http://localhost:${rpcPort}/broadcast_tx_commit`, {
      params: {
        tx: txBytes
      }
    })
    let response = {
      result: result.data.result
    }
    res.json(response)
  })

  app.get('/context', (req, res) => {
    res.json(stateMachine.context())
  })

  app.use('/tendermint', proxy(`http://localhost:${rpcPort}`))

  app.get('/query', async (req, res) => {
    let state = {}
    let params = Object.keys(req.query).map((key)=>{
      return `${key}=${req.query[key]}`
    })

    // let request = {
    //   data: undefined,
    //   height: undefined,
    //   path: undefined
    // }
    //
    // if (req.query.data) {
    //   request.data = Buffer.from(req.query.data.replace(/['"]+/g, ''))
    // }
    //
    // if (req.query.height) {
    //   request.height = parseInt(req.query.height)
    // }
    //
    // if (req.query.path) {
    //   request.path = req.query.path.replace(/['"]+/g, '')
    // }
    //
    // console.log("BUILD REQUEST")
    // console.log(request)
    //
    // let queryResponse  = await stateMachine.query(request)
    // console.log(queryResponse)
    //
    // res.send({
    //   log: `${queryResponse.log ? queryResponse.log : 'Error in response from queryHandler.'}`,
    //   code: `${queryResponse.code ? queryResponse.code : '-1'}`,
    //   value: queryResponse.value,
    //   height: queryResponse.height ? queryResponse.height : -1
    // })
    //
    // console.log(req.query)
    //
    //
    let requestString = `http://localhost:${rpcPort}/abci_query${params?'?'+params.join('&'):''}`
    // console.log(requestString)
    var [error, result] = await to(axios.get(requestString))
    if (!error && !result.data.error) {
      result.data.result.response.value = JSON.parse(Buffer.from(result.data.result.response.value, 'base64').toString())
    }
    res.send(result.data.result.response)
  })

  return app
}
