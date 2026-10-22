using Microsoft.EntityFrameworkCore;
using SpiceErp.Api.Data;
using SpiceErp.Api.Infrastructure;

namespace SpiceErp.Api.Services;

/// <summary>Outcome of posting a business document. Data carries server-authoritative values for the device.</summary>
public record PostResult(Guid Id, string Number, string Status, List<string> Warnings, object? Data = null)
{
    public static PostResult Applied(Guid id, string number, List<string>? warnings = null, object? data = null)
        => new(id, number, "applied", warnings ?? new List<string>(), data);
    public static PostResult Duplicate(Guid id, string number, object? data = null)
        => new(id, number, "duplicate", new List<string>(), data);
}

public static class Methods
{
    public static readonly string[] Payment = { "CASH", "BANK", "WALLET" };
    public static readonly string[] InvoicePayment = { "CASH", "CREDIT", "BANK", "WALLET" };

    public static string Upper(string? v) => (v ?? "").Trim().ToUpperInvariant();
}

/// <summary>Document-number helper shared by services.</summary>
public class Numbering
{
    private readonly AppDbContext _db;
    private readonly ICurrentUser _user;
    private readonly PostingService _post;

    public Numbering(AppDbContext db, ICurrentUser user, PostingService post) { _db = db; _user = user; _post = post; }

    /// <summary>
    /// Offline documents carry a device number such as INV-D03-00017. The device prefix is
    /// allocated by the server at registration, so numbers are unique across devices without
    /// a shared counter. Documents created without a device number get a server number (INV-S-00001).
    /// </summary>
    public async Task<string> ResolveAsync(string? clientNumber, string docPrefix, string docType)
    {
        if (!string.IsNullOrWhiteSpace(clientNumber))
        {
            if (_user.DeviceId is null) throw new AppException("bad_number", "Device numbers can only be used from a registered device.");
            var prefix = await _db.Devices.Where(d => d.Id == _user.DeviceId && d.BusinessId == _user.BusinessId)
                .Select(d => d.Prefix).FirstOrDefaultAsync();
            if (prefix is null || !clientNumber.StartsWith($"{docPrefix}-{prefix}-", StringComparison.Ordinal))
                throw new AppException("bad_number", $"Number {clientNumber} does not belong to this device.");
            return clientNumber.Trim();
        }
        return await _post.NextNumberAsync(docType, $"{docPrefix}-S");
    }
}

public static class TransactionExtensions
{
    /// <summary>Runs work in a DB transaction unless one is already open (sync wraps each operation itself).</summary>
    public static async Task<T> InTransactionAsync<T>(this PostingService post, Func<Task<T>> work)
    {
        if (post.Db.Database.CurrentTransaction != null)
        {
            var inner = await work();
            await post.Db.SaveChangesAsync();
            return inner;
        }
        await using var tx = await post.BeginAsync();
        var result = await work();
        await post.Db.SaveChangesAsync();
        await tx.CommitAsync();
        return result;
    }
}
