using Microsoft.EntityFrameworkCore;
using SpiceErp.Api.Data;
using SpiceErp.Api.Infrastructure;
using SpiceErp.Api.Security;

namespace SpiceErp.Api.Services;

/// <summary>Target: BULK (batch, grams) | FINISHED (variation, packets) | DAMAGED (variation, packets) | MATERIAL (units).</summary>
public record AdjustmentInput(string Target, Guid? BatchId, Guid? VariationId, Guid? MaterialId, long QuantityDelta, string Reason);

public record StockCountInput(string Target, Guid? BatchId, Guid? VariationId, Guid? MaterialId, long CountedQuantity, string Reason);

public record DamageInput(Guid VariationId, long Quantity, string Reason);

/// <summary>Authorised stock corrections. History is never edited — every change is a new ledger row with a reason.</summary>
public class InventoryService
{
    private readonly AppDbContext _db;
    private readonly PostingService _post;
    private readonly ICurrentUser _user;

    public InventoryService(AppDbContext db, PostingService post, ICurrentUser user) { _db = db; _post = post; _user = user; }

    public async Task<PostResult> AdjustAsync(AdjustmentInput input)
    {
        _user.Require(Perm.InventoryAdjust);
        if (input.QuantityDelta == 0) throw new AppException("zero", "The adjustment quantity cannot be zero.");
        if (string.IsNullOrWhiteSpace(input.Reason)) throw new AppException("reason_required", "A reason is required for every stock adjustment.");
        var target = Methods.Upper(input.Target);
        var now = DateTime.UtcNow;
        var adj = new StockAdjustment
        {
            BusinessId = _user.BusinessId, AdjustmentNo = await _post.NextNumberAsync("ADJUSTMENT", "ADJ"), Target = target,
            QuantityDelta = input.QuantityDelta, Reason = input.Reason.Trim(), ApprovedBy = _user.UserId, CreatedBy = _user.UserId
        };

        switch (target)
        {
            case "BULK":
            {
                var batch = await _db.Batches.FirstOrDefaultAsync(b => b.Id == input.BatchId && b.BusinessId == _user.BusinessId) ?? throw AppException.NotFound("Batch");
                await _post.LockAsync("Batches", new[] { batch.Id });
                var onHand = await _post.BatchGramsAsync(batch.Id);
                if (onHand + input.QuantityDelta < 0) throw new AppException("negative", $"Batch {batch.BatchNo} has only {onHand:N0} g.");
                adj.ProductId = batch.ProductId; adj.BatchId = batch.Id;
                _post.Bulk(batch.ProductId, batch.Id, input.QuantityDelta, batch.UnitCostPerGram, "ADJUSTMENT", "StockAdjustment", adj.Id, now, adj.Reason);
                break;
            }
            case "FINISHED":
            case "DAMAGED":
            {
                var v = await _db.ProductVariations.FirstOrDefaultAsync(x => x.Id == input.VariationId && x.BusinessId == _user.BusinessId) ?? throw AppException.NotFound("Packet size");
                await _post.LockAsync("ProductVariations", new[] { v.Id });
                adj.ProductId = v.ProductId; adj.VariationId = v.Id;
                if (target == "FINISHED")
                {
                    var onHand = await _post.FinishedPacketsAsync(v.Id);
                    if (onHand + input.QuantityDelta < 0) throw new AppException("negative", $"Only {onHand} packets in stock.");
                    if (input.QuantityDelta > 0) await _post.FinishedInAsync(v, input.QuantityDelta, v.AvgUnitCost, "ADJUSTMENT", "StockAdjustment", adj.Id, now, adj.Reason);
                    else _post.FinishedOut(v, -input.QuantityDelta, "ADJUSTMENT", "StockAdjustment", adj.Id, now, adj.Reason);
                }
                else
                {
                    var onHand = await _post.DamagedPacketsAsync(v.Id);
                    if (onHand + input.QuantityDelta < 0) throw new AppException("negative", $"Only {onHand} damaged packets recorded.");
                    _post.Damaged(v.ProductId, v.Id, "PKT", input.QuantityDelta, v.AvgUnitCost, input.QuantityDelta < 0 ? "WRITE_OFF" : "ADJUSTMENT", "StockAdjustment", adj.Id, now, adj.Reason);
                }
                break;
            }
            case "MATERIAL":
            {
                var m = await _db.PackagingMaterials.FirstOrDefaultAsync(x => x.Id == input.MaterialId && x.BusinessId == _user.BusinessId) ?? throw AppException.NotFound("Packaging material");
                await _post.LockAsync("PackagingMaterials", new[] { m.Id });
                var onHand = await _post.MaterialQtyAsync(m.Id);
                if (onHand + input.QuantityDelta < 0) throw new AppException("negative", $"Only {onHand} {m.Unit} in stock.");
                adj.MaterialId = m.Id;
                if (input.QuantityDelta > 0) await _post.MaterialInAsync(m, input.QuantityDelta, m.AvgUnitCost, "ADJUSTMENT", "StockAdjustment", adj.Id, now, adj.Reason);
                else _post.MaterialOut(m, -input.QuantityDelta, "ADJUSTMENT", "StockAdjustment", adj.Id, now, adj.Reason);
                break;
            }
            default:
                throw new AppException("bad_target", "Target must be BULK, FINISHED, DAMAGED or MATERIAL.");
        }

        _db.StockAdjustments.Add(adj);
        _post.Audit("ADJUST", "Stock", adj.Id, $"{adj.AdjustmentNo} {target} {input.QuantityDelta:+#;-#}: {adj.Reason}");
        await _db.SaveChangesAsync();
        return PostResult.Applied(adj.Id, adj.AdjustmentNo);
    }

    /// <summary>Physical count: posts the difference between the counted and system quantity as an adjustment.</summary>
    public async Task<PostResult> CountAsync(StockCountInput input)
    {
        _user.Require(Perm.InventoryAdjust);
        if (input.CountedQuantity < 0) throw new AppException("bad_quantity", "Counted quantity cannot be negative.");
        var target = Methods.Upper(input.Target);
        long system = target switch
        {
            "BULK" => await _post.BatchGramsAsync(input.BatchId ?? Guid.Empty),
            "FINISHED" => await _post.FinishedPacketsAsync(input.VariationId ?? Guid.Empty),
            "DAMAGED" => await _post.DamagedPacketsAsync(input.VariationId ?? Guid.Empty),
            "MATERIAL" => await _post.MaterialQtyAsync(input.MaterialId ?? Guid.Empty),
            _ => throw new AppException("bad_target", "Unknown stock target.")
        };
        var delta = input.CountedQuantity - system;
        if (delta == 0) return PostResult.Applied(Guid.Empty, "", new List<string> { "Count matches the system quantity; nothing posted." });
        return await AdjustAsync(new AdjustmentInput(target, input.BatchId, input.VariationId, input.MaterialId, delta,
            $"Physical count {input.CountedQuantity} vs system {system}. {input.Reason}".Trim()));
    }

    /// <summary>Moves saleable packets into the damaged bucket (e.g. torn pouches found in the store).</summary>
    public async Task<PostResult> MarkDamagedAsync(DamageInput input)
    {
        _user.Require(Perm.InventoryAdjust);
        if (input.Quantity <= 0) throw new AppException("bad_quantity", "Quantity must be greater than zero.");
        if (string.IsNullOrWhiteSpace(input.Reason)) throw new AppException("reason_required", "A reason is required.");
        await _post.LockAsync("ProductVariations", new[] { input.VariationId });
        var v = await _db.ProductVariations.FirstOrDefaultAsync(x => x.Id == input.VariationId && x.BusinessId == _user.BusinessId) ?? throw AppException.NotFound("Packet size");
        var onHand = await _post.FinishedPacketsAsync(v.Id);
        if (onHand < input.Quantity) throw new AppException("negative", $"Only {onHand} packets in stock.");
        var id = Guid.NewGuid();
        var now = DateTime.UtcNow;
        var cost = _post.FinishedOut(v, input.Quantity, "DAMAGE", "Damage", id, now, input.Reason);
        _post.Damaged(v.ProductId, v.Id, "PKT", input.Quantity, cost, "DAMAGE", "Damage", id, now, input.Reason);
        _post.Audit("DAMAGE", "Stock", id, $"{input.Quantity} packets of variation {v.Sku} marked damaged: {input.Reason}");
        await _db.SaveChangesAsync();
        return PostResult.Applied(id, "");
    }
}
