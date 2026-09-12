# Finance Data API

Minimal Azure Functions (.NET 8, isolated worker) backend for the Personal
Finance Manager's "Server Sync" feature. Stores one shared JSON file (an
Azure Blob) and exposes it as:

- `GET  /api/data` — returns the current data (seeds an empty default the
  first time it's called, if the blob doesn't exist yet).
- `PUT  /api/data` — overwrites the data with the JSON body sent (basic
  shape validation only — last write wins, no merge).

There is **no authentication** on these endpoints, by design, matching the
"single user, private network only" requirement. **Do not deploy this
Function App with public network access enabled** — see "Securing it"
below before you deploy anywhere reachable from the internet.

## Prerequisites

- An Azure subscription
- .NET 8 SDK
- Azure Functions Core Tools v4 (`npm i -g azure-functions-core-tools@4`)
  or the Azure Functions extension in VS Code / Visual Studio
- An Azure Storage account (any general-purpose v2 account works — this
  is where the JSON blob actually lives)

## Configuration (Application Settings)

| Setting                    | Purpose                                              | Default                        |
|-----------------------------|-------------------------------------------------------|---------------------------------|
| `FinanceDataStorage`        | Connection string of the storage account holding the blob | *(required, no default)* |
| `FinanceDataContainerName`  | Blob container name (auto-created if missing)        | `finance-data`                  |
| `FinanceDataBlobName`       | Blob name                                             | `personal-finance-data.json`    |
| `AllowedOrigin`             | Value sent as `Access-Control-Allow-Origin`           | `*`                              |

`AllowedOrigin`: if you're serving `index.html` from a real origin (e.g. an
Azure Static Web App or Storage static website), set this to that exact
origin (`https://yoursite.z13.web.core.windows.net`) instead of `*`. If
you're just opening `index.html` as a local file (`file://`), leave it as
`*` — a `file://` page has no origin for a specific-origin CORS rule to
match against.

## Running locally

```bash
cd FinanceDataApi
# local.settings.json already points at the Azurite storage emulator —
# start it first (npm i -g azurite && azurite) or point FinanceDataStorage
# at a real storage account connection string instead.
func start
```

Then test it:

```bash
curl http://localhost:7071/api/data
curl -X PUT http://localhost:7071/api/data -H "Content-Type: application/json" -d "{\"accounts\":[],\"transactions\":[],\"settings\":{}}"
```

## Deploying to Azure

```bash
# One-time setup (adjust names/region as you like)
az group create --name rg-finance-data --location eastus
az storage account create --name financedatastore --resource-group rg-finance-data --sku Standard_LRS
az functionapp create --name financedata-api --resource-group rg-finance-data \
    --storage-account financedatastore --consumption-plan-location eastus \
    --runtime dotnet-isolated --functions-version 4

# Point the function at the storage account that holds the JSON blob
# (can be the same account used above, or a separate one)
CONN_STRING=$(az storage account show-connection-string --name financedatastore --resource-group rg-finance-data --query connectionString -o tsv)
az functionapp config appsettings set --name financedata-api --resource-group rg-finance-data \
    --settings FinanceDataStorage="$CONN_STRING" AllowedOrigin="*"

# Deploy the code
func azure functionapp publish financedata-api
```

Your API base URL will be `https://financedata-api.azurewebsites.net` —
that's what you paste into the app's **Settings → Server Sync → Server
Address** field (the app appends `/api/data` itself).

## Securing it (read this before deploying)

Since there's no login on the API itself, access control has to happen at
the network layer. Pick one:

**Option A — IP allowlist (simplest, works with any VPN)**

Restrict the Function App to only accept traffic from your VPN's public
egress IP, and deny everything else:

```bash
az functionapp config access-restriction add --name financedata-api --resource-group rg-finance-data \
    --rule-name "VpnOnly" --action Allow --ip-address <your-vpn-public-ip>/32 --priority 100

az functionapp config access-restriction add --name financedata-api --resource-group rg-finance-data \
    --rule-name "DenyAll" --action Deny --ip-address 0.0.0.0/0 --priority 200
```

**Option B — Private Endpoint + VNet (if you already run a real Azure VPN
Gateway / ExpressRoute into a VNet)**

Disable public network access on the Function App entirely and expose it
only via a Private Endpoint inside your VNet, so it's simply unreachable
from the public internet at all:

```bash
az functionapp update --name financedata-api --resource-group rg-finance-data \
    --set publicNetworkAccess=Disabled
# then create a Private Endpoint into your VNet via the portal or
# `az network private-endpoint create`, pointing at this Function App.
```

Either way: verify from a machine **outside** your VPN that `curl
https://financedata-api.azurewebsites.net/api/data` fails/times out before
you trust this with real data.

## Data format

The blob's JSON is exactly the shape the app's own manual "Backup / Restore"
feature already exports/imports:

```json
{
  "dataVersion": 1,
  "appVersion": "1.0.0",
  "exportedAt": "2026-09-12T10:00:00.000Z",
  "accounts": [ ... ],
  "transactions": [ ... ],
  "settings": { ... }
}
```

This means a file exported from the app's Backup tab can be uploaded
directly as the blob's initial content if you want to seed it with
existing data, and the reverse works too (the server's content is valid
input to the app's Restore-from-backup import).
