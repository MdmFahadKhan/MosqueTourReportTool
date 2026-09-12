using System.Net;
using System.Text;
using System.Text.Json;
using Azure.Storage.Blobs;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.Extensions.Logging;

namespace FinanceDataApi;

/// <summary>
/// Backs the Personal Finance Manager's "Server Sync" feature. Stores one
/// shared JSON blob (the same shape as the app's own Backup export) and
/// exposes it as GET/PUT /api/data.
///
/// There is deliberately no authentication here. This is meant to sit
/// behind network-level access control only (VPN / private network /
/// Azure Function "Access Restrictions") — see the accompanying README
/// before deploying this anywhere reachable from the public internet.
/// </summary>
public class FinanceDataFunctions
{
    // Matches the client's own DEFAULTS in the app's Storage module, so a
    // brand-new deployment behaves exactly like a brand-new browser profile.
    private const string DefaultPayload = """
    {
      "dataVersion": 1,
      "appVersion": "1.0.0",
      "exportedAt": null,
      "accounts": [],
      "transactions": [],
      "settings": {
        "pinHash": null,
        "pinSalt": null,
        "securityQuestion": null,
        "securityAnswerHash": null,
        "securityAnswerSalt": null
      }
    }
    """;

    private readonly BlobServiceClient _blobServiceClient;
    private readonly ILogger<FinanceDataFunctions> _logger;
    private readonly string _containerName;
    private readonly string _blobName;
    private readonly string _allowedOrigin;

    public FinanceDataFunctions(BlobServiceClient blobServiceClient, ILogger<FinanceDataFunctions> logger)
    {
        _blobServiceClient = blobServiceClient;
        _logger = logger;
        _containerName = Environment.GetEnvironmentVariable("FinanceDataContainerName") ?? "finance-data";
        _blobName = Environment.GetEnvironmentVariable("FinanceDataBlobName") ?? "personal-finance-data.json";
        // Set this to your exact site origin in production (e.g.
        // "https://myfinancetool.z13.web.core.windows.net"). "*" is the
        // simplest default for a private-network-only deployment.
        _allowedOrigin = Environment.GetEnvironmentVariable("AllowedOrigin") ?? "*";
    }

    [Function("DataOptions")]
    public HttpResponseData HandleOptions(
        [HttpTrigger(AuthorizationLevel.Anonymous, "options", Route = "data")] HttpRequestData req)
    {
        var response = req.CreateResponse(HttpStatusCode.NoContent);
        ApplyCorsHeaders(response);
        response.Headers.Add("Access-Control-Allow-Methods", "GET, PUT, OPTIONS");
        response.Headers.Add("Access-Control-Allow-Headers", "Content-Type");
        return response;
    }

    [Function("GetData")]
    public async Task<HttpResponseData> GetData(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "data")] HttpRequestData req)
    {
        var blobClient = await GetBlobClientAsync();

        string content;
        if (!await blobClient.ExistsAsync())
        {
            content = DefaultPayload;
            using var seedStream = new MemoryStream(Encoding.UTF8.GetBytes(content));
            await blobClient.UploadAsync(seedStream, overwrite: true);
            _logger.LogInformation("No existing data blob found; seeded {BlobName} with defaults.", _blobName);
        }
        else
        {
            var download = await blobClient.DownloadContentAsync();
            content = download.Value.Content.ToString();
        }

        var response = req.CreateResponse(HttpStatusCode.OK);
        ApplyCorsHeaders(response);
        response.Headers.Add("Content-Type", "application/json; charset=utf-8");
        await response.WriteStringAsync(content);
        return response;
    }

    [Function("SaveData")]
    public async Task<HttpResponseData> SaveData(
        [HttpTrigger(AuthorizationLevel.Anonymous, "put", Route = "data")] HttpRequestData req)
    {
        string body;
        using (var reader = new StreamReader(req.Body))
        {
            body = await reader.ReadToEndAsync();
        }

        // Defense in depth: the client already validates shape before
        // syncing, but never trust the wire — reject anything that isn't
        // at minimum well-formed JSON with the expected top-level shape
        // before overwriting the one shared file.
        if (!IsValidPayload(body, out var validationError))
        {
            var badResponse = req.CreateResponse(HttpStatusCode.BadRequest);
            ApplyCorsHeaders(badResponse);
            await badResponse.WriteStringAsync(validationError);
            return badResponse;
        }

        var blobClient = await GetBlobClientAsync();
        using var stream = new MemoryStream(Encoding.UTF8.GetBytes(body));
        await blobClient.UploadAsync(stream, overwrite: true);

        var response = req.CreateResponse(HttpStatusCode.NoContent);
        ApplyCorsHeaders(response);
        return response;
    }

    private async Task<BlobClient> GetBlobClientAsync()
    {
        var containerClient = _blobServiceClient.GetBlobContainerClient(_containerName);
        await containerClient.CreateIfNotExistsAsync();
        return containerClient.GetBlobClient(_blobName);
    }

    private static bool IsValidPayload(string body, out string error)
    {
        error = string.Empty;
        try
        {
            using var doc = JsonDocument.Parse(body);
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object ||
                !root.TryGetProperty("accounts", out var accounts) || accounts.ValueKind != JsonValueKind.Array ||
                !root.TryGetProperty("transactions", out var transactions) || transactions.ValueKind != JsonValueKind.Array)
            {
                error = "Payload must be a JSON object with \"accounts\" and \"transactions\" arrays.";
                return false;
            }
            return true;
        }
        catch (JsonException ex)
        {
            error = "Payload is not valid JSON: " + ex.Message;
            return false;
        }
    }

    private void ApplyCorsHeaders(HttpResponseData response)
    {
        response.Headers.Add("Access-Control-Allow-Origin", _allowedOrigin);
    }
}
