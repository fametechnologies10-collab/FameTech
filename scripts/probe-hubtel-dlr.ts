import { loadEnvConfig } from '@next/env'
loadEnvConfig(process.cwd())
const MID = '228560df-2171-48b9-8645-7ad466ce6411' // the KFT Test send
async function main() {
  const id = process.env.HUBTEL_CLIENT_ID, sec = process.env.HUBTEL_CLIENT_SECRET
  if (!id || !sec) { console.error('creds missing'); process.exit(1) }
  const auth = Buffer.from(`${id}:${sec}`).toString('base64')
  const res = await fetch(`https://sms.hubtel.com/v1/messages/${MID}`, { headers: { Accept: 'application/json', Authorization: `Basic ${auth}` } })
  const data = await res.json().catch(()=>({}))
  console.log('HTTP', res.status)
  console.log(JSON.stringify(data, null, 2))
}
main().catch(e=>{console.error(e?.message);process.exit(1)})
