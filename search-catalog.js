import 'dotenv/config';

const bearerToken = process.env.BEARER_TOKEN;
let catalogId = process.env.CATALOG_ID;

fetch('https://discover.shopifyapps.com/global/mcp', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${bearerToken}`
  },
  body: JSON.stringify({
    jsonrpc: '2.0',
    method: 'tools/call',
    id: 1,
    params: {
      name: 'search_global_products',
      arguments: {
        saved_catalog: catalogId,
        query: 'I need a crewneck sweater',
        context: 'buyer looking for sustainable fashion',
        limit: 3
      }
    }
  })
})
.then(res => res.json())
.then(data => {
  if (data && data.result?.content?.[0]?.text) {
    // Parse the stringified text field
    data.result.content[0].text = JSON.parse(data.result.content[0].text);
  }
  if (data) {
    console.log(JSON.stringify(data, null, 2));
  }
})
.catch(err => console.error('Request failed:', err));
