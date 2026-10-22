using Microsoft.EntityFrameworkCore;
using SpiceErp.Api.Data;
using SpiceErp.Api.Infrastructure;
using SpiceErp.Api.Security;

namespace SpiceErp.Api.Services;

public record PackingOrderInput(Guid VariationId, Guid BatchId, int PlannedPackets, DateOnly PackDate, Guid? AssignedToUserId, string? Notes);

public record PackingPostInput(int ProducedPackets, int RejectedPackets, long LossGrams, long PouchesUsed, long LabelsUsed,
    decimal LabourCost, decimal OverheadCost, string? Notes);

/// <summary>
/// Converts bulk spice (grams, from one batch) into packets of one size.
/// Grams consumed = (produced + rejected) × packet size + measured loss. Anything not consumed stays
/// in the batch as leftover — the system never assumes the planned quantity was produced.
/// Packet cost = (spice consumed + packaging used + labour + overhead) ÷ saleable packets produced.
/// </summary>
public class PackingService
{
    private readonly AppDbContext _db;
    private readonly PostingService _post;
    private readonly ICurrentUser _user;

    public PackingService(AppDbContext db, PostingService post, ICurrentUser user) { _db = db; _post = post; _user = user; }

    public async Task<PostResult> CreateAsync(PackingOrderInput input)
    {
        _user.Require(Perm.PackingManage);
        if (input.PlannedPackets <= 0) throw new AppException("bad_quantity", "Planned packets must be greater than zero.");
        var v = await _db.ProductVariations.FirstOrDefaultAsync(x => x.Id == input.VariationId && x.BusinessId == _user.BusinessId)
                ?? throw AppException.NotFound("Packet size");
        var batch = await _db.Batches.FirstOrDefaultAsync(b => b.Id == input.BatchId && b.BusinessId == _user.BusinessId)
                    ?? throw AppException.NotFound("Batch");
        if (batch.ProductId != v.ProductId) throw new AppException("batch_mismatch", "The batch belongs to a different spice.");

        var planned = (long)input.PlannedPackets * v.PacketGrams;
        var available = await _post.BatchGramsAsync(batch.Id);
        var business = await _post.BusinessAsync();
        var warnings = new List<string>();
        if (available < planned && !business.AllowNegativeStock)
            throw new AppException("insufficient_bulk", $"Batch {batch.BatchNo} has {available:N0} g; {planned:N0} g are needed for {input.PlannedPackets} × {v.PacketGrams} g.");
        if (batch.ExpiryDate.HasValue && batch.ExpiryDate.Value < DateOnly.FromDateTime(DateTime.UtcNow))
            warnings.Add($"Batch {batch.BatchNo} expired on {batch.ExpiryDate:yyyy-MM-dd}.");

        foreach (var (matId, label) in new[] { (v.PouchMaterialId, "pouches"), (v.LabelMaterialId, "labels") })
        {
            if (!matId.HasValue) continue;
            var qty = await _post.MaterialQtyAsync(matId.Value);
            if (qty < input.PlannedPackets) warnings.Add($"Only {qty} {label} in stock for {input.PlannedPackets} packets.");
        }

        var order = new PackingOrder
        {
            BusinessId = _user.BusinessId, OrderNo = await _post.NextNumberAsync("PACKING", "PKO"), ProductId = v.ProductId,
            VariationId = v.Id, BatchId = batch.Id, PackDate = input.PackDate, PlannedPackets = input.PlannedPackets,
            PlannedGrams = planned, AssignedToUserId = input.AssignedToUserId, Notes = input.Notes, CreatedBy = _user.UserId
        };
        _db.PackingOrders.Add(order);
        _post.Audit("CREATE", "PackingOrder", order.Id, $"Packing order {order.OrderNo}: {order.PlannedPackets} × {v.PacketGrams} g from batch {batch.BatchNo}");
        await _db.SaveChangesAsync();
        return PostResult.Applied(order.Id, order.OrderNo, warnings);
    }

    public async Task<PostResult> PostAsync(Guid id, PackingPostInput input)
    {
        _user.Require(Perm.PackingPost);
        if (input.ProducedPackets < 0 || input.RejectedPackets < 0 || input.LossGrams < 0 || input.PouchesUsed < 0 || input.LabelsUsed < 0
            || input.LabourCost < 0 || input.OverheadCost < 0)
            throw new AppException("bad_quantity", "Quantities and costs cannot be negative.");
        if (input.ProducedPackets + input.RejectedPackets == 0 && input.LossGrams == 0)
            throw new AppException("nothing_to_post", "Enter the packets produced, rejected or the loss.");
        if ((input.LabourCost > 0 || input.OverheadCost > 0) && !_user.Has(Perm.PackingManage))
            throw AppException.Forbidden("Only supervisors can enter labour or overhead cost.");

        var order = await _db.PackingOrders.FirstOrDefaultAsync(o => o.Id == id && o.BusinessId == _user.BusinessId)
                    ?? throw AppException.NotFound("Packing order");
        if (order.Status != "PLANNED") throw new AppException("bad_status", "This packing order is already posted or cancelled.");

        await _post.LockAsync("Batches", new[] { order.BatchId });
        await _post.LockAsync("ProductVariations", new[] { order.VariationId });
        var v = await _db.ProductVariations.FirstAsync(x => x.Id == order.VariationId);
        var batch = await _db.Batches.FirstAsync(x => x.Id == order.BatchId);
        var business = await _post.BusinessAsync();

        var consumed = (long)(input.ProducedPackets + input.RejectedPackets) * v.PacketGrams + input.LossGrams;
        var available = await _post.BatchGramsAsync(batch.Id);
        if (consumed > available && !business.AllowNegativeStock)
            throw new AppException("insufficient_bulk", $"Batch {batch.BatchNo} has {available:N0} g but {consumed:N0} g would be consumed.");

        var now = DateTime.UtcNow;
        decimal materialCost = 0;
        var materials = new List<(Guid? id, long qty, string label)> { (v.PouchMaterialId, input.PouchesUsed, "pouches"), (v.LabelMaterialId, input.LabelsUsed, "labels") };
        foreach (var (matId, qty, label) in materials)
        {
            if (qty == 0) continue;
            if (!matId.HasValue) throw new AppException("no_material", $"No {label} material is linked to this packet size. Link it under Products.");
            await _post.LockAsync("PackagingMaterials", new[] { matId.Value });
            var m = await _db.PackagingMaterials.FirstAsync(x => x.Id == matId.Value);
            var onHand = await _post.MaterialQtyAsync(m.Id);
            if (onHand < qty && !business.AllowNegativeStock)
                throw new AppException("insufficient_material", $"{m.Name}: {onHand} in stock, {qty} needed.");
            materialCost += qty * _post.MaterialOut(m, qty, "PACK_CONSUME", "PackingOrder", order.Id, now, order.OrderNo);
        }

        order.ProducedPackets = input.ProducedPackets;
        order.RejectedPackets = input.RejectedPackets;
        order.LossGrams = input.LossGrams;
        order.ConsumedGrams = consumed;
        order.PouchesUsed = input.PouchesUsed;
        order.LabelsUsed = input.LabelsUsed;
        order.SpiceCost = Money.R2(consumed * batch.UnitCostPerGram);
        order.MaterialCost = Money.R2(materialCost);
        order.LabourCost = Money.R2(input.LabourCost);
        order.OverheadCost = Money.R2(input.OverheadCost);
        order.TotalCost = order.SpiceCost + order.MaterialCost + order.LabourCost + order.OverheadCost;
        order.UnitCost = order.ProducedPackets > 0 ? Money.R6(order.TotalCost / order.ProducedPackets) : 0;
        order.Status = "POSTED"; order.PostedAt = now; order.PostedBy = _user.UserId;
        if (!string.IsNullOrWhiteSpace(input.Notes)) order.Notes = input.Notes;
        order.Version++;

        if (consumed > 0)
            _post.Bulk(batch.ProductId, batch.Id, -consumed, batch.UnitCostPerGram, "PACK_CONSUME", "PackingOrder", order.Id, now, order.OrderNo);
        if (order.ProducedPackets > 0)
            await _post.FinishedInAsync(v, order.ProducedPackets, order.UnitCost, "PACK_PRODUCE", "PackingOrder", order.Id, now, order.OrderNo);
        if (order.RejectedPackets > 0)
            _post.Damaged(v.ProductId, v.Id, "PKT", order.RejectedPackets, 0, "PACK_REJECT", "PackingOrder", order.Id, now, $"Rejected in {order.OrderNo} (cost absorbed by good packets)");

        var warnings = new List<string>();
        if (order.ProducedPackets < order.PlannedPackets)
            warnings.Add($"Produced {order.ProducedPackets} of {order.PlannedPackets} planned packets. {available - consumed:N0} g remain in batch {batch.BatchNo}.");

        _post.Audit("POST", "PackingOrder", order.Id,
            $"{order.OrderNo}: produced {order.ProducedPackets}, rejected {order.RejectedPackets}, loss {order.LossGrams} g, consumed {consumed} g, unit cost {order.UnitCost:0.00}");
        await _db.SaveChangesAsync();
        return PostResult.Applied(order.Id, order.OrderNo, warnings, new { order.UnitCost, order.TotalCost, order.ConsumedGrams });
    }

    public async Task CancelAsync(Guid id, string reason)
    {
        _user.Require(Perm.PackingManage);
        if (string.IsNullOrWhiteSpace(reason)) throw new AppException("reason_required", "A cancellation reason is required.");
        var order = await _db.PackingOrders.FirstOrDefaultAsync(o => o.Id == id && o.BusinessId == _user.BusinessId)
                    ?? throw AppException.NotFound("Packing order");
        var now = DateTime.UtcNow;

        if (order.Status == "POSTED")
        {
            await _post.LockAsync("ProductVariations", new[] { order.VariationId });
            var v = await _db.ProductVariations.FirstAsync(x => x.Id == order.VariationId);
            var batch = await _db.Batches.FirstAsync(x => x.Id == order.BatchId);
            var onHand = await _post.FinishedPacketsAsync(v.Id);
            if (onHand < order.ProducedPackets)
                throw new AppException("packets_sold", $"Only {onHand} packets are in stock; {order.ProducedPackets} would need to be reversed. Use a stock adjustment.");
            var damaged = await _post.DamagedPacketsAsync(v.Id);
            if (damaged < order.RejectedPackets)
                throw new AppException("rejects_moved", "The rejected packets have already been written off.");

            if (order.ProducedPackets > 0)
                await _post.FinishedReverseInboundAsync(v, order.ProducedPackets, order.UnitCost, "PACK_CANCEL", "PackingOrder", order.Id, now, reason);
            if (order.RejectedPackets > 0)
                _post.Damaged(v.ProductId, v.Id, "PKT", -order.RejectedPackets, 0, "PACK_CANCEL", "PackingOrder", order.Id, now, reason);
            if (order.ConsumedGrams > 0)
                _post.Bulk(batch.ProductId, batch.Id, order.ConsumedGrams, batch.UnitCostPerGram, "PACK_CANCEL", "PackingOrder", order.Id, now, reason);

            // Return packaging at the cost it was issued at.
            var issued = await _db.PackagingMaterialTransactions
                .Where(t => t.SourceType == "PackingOrder" && t.SourceId == order.Id && t.MovementType == "PACK_CONSUME").ToListAsync();
            foreach (var t in issued)
            {
                var m = await _db.PackagingMaterials.FirstAsync(x => x.Id == t.MaterialId);
                await _post.MaterialInAsync(m, -t.Quantity, t.UnitCost, "PACK_CANCEL", "PackingOrder", order.Id, now, reason);
            }
        }
        else if (order.Status != "PLANNED")
        {
            throw new AppException("bad_status", "This packing order is already cancelled.");
        }

        order.Status = "CANCELLED"; order.CancelledAt = now; order.CancelledBy = _user.UserId; order.CancelReason = reason;
        order.Version++;
        _post.Audit("CANCEL", "PackingOrder", order.Id, $"{order.OrderNo} cancelled: {reason}");
        await _db.SaveChangesAsync();
    }
}
