const axios = require('axios')
const nodeCron = require('node-cron')
let connect = require('lotion-connect')


// let genesis = JSON.parse(require('fs').readFileSync('genesis.json', { encoding: 'utf8' }))
let client
let nodes = ['ws://localhost:46657']
let period = Math.round(15+Math.random()*45)
let cron = `*/${period} * * * * *`

try {
  for (let validator of genesis.validators) {
    if (validator.ip) {
      nodes.push(`ws://${validator.ip}:46657`)
    }
  }
} catch(err) {
  console.log("Error fetching peer IPs", err)
}

const main = async function() {
  console.log(`Connecting to one of nodes: ${nodes}`)
  client = await connect(null, {genesis, nodes})
  let state = await client.getState()
  console.log("State:")
  console.log(JSON.stringify(state, null, 2))
  let tx = {nonce: state.count++}
  console.log("Tx:")
  console.log(JSON.stringify(tx, null, 2))
  let result = await client.send(tx)
  console.log(result)
}

if (cron) {
  console.log(`Starting cron using: '${cron}'`)
  nodeCron.schedule(cron, function() {
    main()
  })
} else {
  console.log('Starting main()')
  main()
}
