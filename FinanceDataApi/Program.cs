using Azure.Storage.Blobs;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

var host = new HostBuilder()
    .ConfigureFunctionsWorkerDefaults()
    .ConfigureServices(services =>
    {
        services.AddSingleton(_ =>
        {
            var connectionString = Environment.GetEnvironmentVariable("FinanceDataStorage");
            if (string.IsNullOrWhiteSpace(connectionString))
            {
                throw new InvalidOperationException(
                    "Application setting 'FinanceDataStorage' (a storage account connection string) is not configured.");
            }
            return new BlobServiceClient(connectionString);
        });
    })
    .Build();

host.Run();
