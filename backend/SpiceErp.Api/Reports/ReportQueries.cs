using Dapper;
using Npgsql;
using SpiceErp.Api.Infrastructure;

namespace SpiceErp.Api.Reports;

/// <summary>
/// Read-only reporting with Dapper. All stock figures come from the InventoryTransactions ledger
/// (through the v* views defined in schema.sql) and all money from posted documents and ledgers —
/// the same tables EF Core writes, so there is one definition of stock and profit.
///
/// Profit method (labelled "estimate" in the UI):
///   Net sales      = posted invoice totals excl. tax − returns excl. tax
///   COGS           = Σ qty × unit cost at sale (weighted average incl. packing cost) − cost of restocked returns
///   Gross profit   = Net sales − COGS
///   Operating exp. = posted expenses − labour/overhead capitalised into packed stock in the period
///   Stock losses   = negative stock adjustments + packets marked damaged (at cost)
///   Net profit     = Gross profit − Operating expenses − Stock losses
/// </summary>
public class ReportQueries
{
    private readonly NpgsqlDataSource _ds;
    private readonly ICurrentUser _user;

    public ReportQueries(NpgsqlDataSource ds, ICurrentUser user) { _ds = ds; _user = user; }

    private const string Tz = "'Asia/Karachi'";

    public static (DateTime from, DateTime to) Range(DateOnly? from, DateOnly? to)
    {
        var today = DateOnly.FromDateTime(DateTime.UtcNow.AddHours(5));
        var f = from ?? today; var t = to ?? f;
        if (t < f) (f, t) = (t, f);
        if (t.DayNumber - f.DayNumber > 3660) throw new AppException("range", "Date range is too large.");
        return (f.ToDateTime(TimeOnly.MinValue), t.ToDateTime(TimeOnly.MinValue));
    }

    private object P(DateOnly? from, DateOnly? to, object? extra = null)
    {
        var (f, t) = Range(from, to);
        var d = new DynamicParameters(extra);
        d.Add("b", _user.BusinessId);
        d.Add("from", f);
        d.Add("to", t);
        return d;
    }

    // ------------------------------------------------------------------ profit core (shared)
    private const string ProfitSql = @"
WITH s AS (
  SELECT COALESCE(SUM(""Total""),0) total, COALESCE(SUM(""Total"" - ""TaxAmount""),0) net, COALESCE(SUM(""CostTotal""),0) cogs,
         COALESCE(SUM(""DiscountAmount""),0) discounts, count(*) invoices,
         COALESCE(SUM(CASE WHEN ""PaymentMethod"" = 'CREDIT' THEN ""Total"" ELSE 0 END),0) credit_sales
  FROM ""SalesInvoices""
  WHERE ""BusinessId"" = @b AND ""Status"" = 'POSTED' AND (""InvoiceDate"" AT TIME ZONE " + Tz + @")::date BETWEEN @from::date AND @to::date),
r AS (
  SELECT COALESCE(SUM(rl.""LineTotal""),0) total,
         COALESCE(SUM(rl.""LineTotal"" * CASE WHEN il.""LineTotal"" > 0 THEN (il.""LineTotal"" - il.""TaxAmount"") / il.""LineTotal"" ELSE 1 END),0) net,
         COALESCE(SUM(CASE WHEN rl.""Restock"" THEN rl.""Quantity"" * rl.""UnitCost"" ELSE 0 END),0) restocked_cost
  FROM ""SalesReturns"" sr
  JOIN ""SalesReturnLines"" rl ON rl.""ReturnId"" = sr.""Id""
  JOIN ""SalesInvoiceLines"" il ON il.""Id"" = rl.""InvoiceLineId""
  WHERE sr.""BusinessId"" = @b AND (sr.""ReturnDate"" AT TIME ZONE " + Tz + @")::date BETWEEN @from::date AND @to::date),
e AS (
  SELECT COALESCE(SUM(""Amount""),0) total FROM ""Expenses""
  WHERE ""BusinessId"" = @b AND ""Status"" = 'POSTED' AND (""ExpenseDate"" AT TIME ZONE " + Tz + @")::date BETWEEN @from::date AND @to::date),
cap AS (
  SELECT COALESCE(SUM(""LabourCost"" + ""OverheadCost""),0) total FROM ""PackingOrders""
  WHERE ""BusinessId"" = @b AND ""Status"" = 'POSTED' AND (""PostedAt"" AT TIME ZONE " + Tz + @")::date BETWEEN @from::date AND @to::date),
loss AS (
  SELECT COALESCE(SUM(v),0) total FROM (
    SELECT -SUM(""Quantity"" * ""UnitCost"") v FROM ""InventoryTransactions""
      WHERE ""BusinessId"" = @b AND ""MovementType"" = 'ADJUSTMENT' AND ""Bucket"" IN ('BULK','FINISHED')
        AND (""OccurredAt"" AT TIME ZONE " + Tz + @")::date BETWEEN @from::date AND @to::date
    UNION ALL
    SELECT SUM(""Quantity"" * ""UnitCost"") FROM ""InventoryTransactions""
      WHERE ""BusinessId"" = @b AND ""MovementType"" = 'DAMAGE' AND ""Bucket"" = 'DAMAGED'
        AND (""OccurredAt"" AT TIME ZONE " + Tz + @")::date BETWEEN @from::date AND @to::date
    UNION ALL
    SELECT -SUM(""Quantity"" * ""UnitCost"") FROM ""PackagingMaterialTransactions""
      WHERE ""BusinessId"" = @b AND ""MovementType"" = 'ADJUSTMENT'
        AND (""OccurredAt"" AT TIME ZONE " + Tz + @")::date BETWEEN @from::date AND @to::date) x)
SELECT s.total ""salesTotal"", s.invoices, s.discounts, s.credit_sales ""creditSales"", s.total - s.credit_sales ""cashSales"",
       ROUND(s.net - r.net, 2) ""netSales"", r.total ""returnsTotal"",
       ROUND(s.cogs - r.restocked_cost, 2) ""cogs"",
       ROUND((s.net - r.net) - (s.cogs - r.restocked_cost), 2) ""grossProfit"",
       e.total ""expenses"", cap.total ""capitalisedLabour"", ROUND(loss.total, 2) ""stockLosses"",
       ROUND((s.net - r.net) - (s.cogs - r.restocked_cost) - (e.total - cap.total) - loss.total, 2) ""netProfit""
FROM s, r, e, cap, loss";

    public async Task<object> DashboardAsync(DateOnly? from, DateOnly? to)
    {
        await using var c = await _ds.OpenConnectionAsync();
        var p = P(from, to);
        var profit = await c.QuerySingleAsync(ProfitSql, p);

        var totals = await c.QuerySingleAsync(@"
SELECT
 (SELECT COALESCE(SUM(""Total""),0) FROM ""Purchases"" WHERE ""BusinessId"" = @b AND ""Status"" = 'POSTED' AND ""PurchaseDate"" BETWEEN @from::date AND @to::date) ""purchases"",
 (SELECT COALESCE(SUM(""Amount""),0) FROM ""CustomerReceipts"" WHERE ""BusinessId"" = @b AND ""Status"" = 'POSTED' AND (""ReceiptDate"" AT TIME ZONE 'Asia/Karachi')::date BETWEEN @from::date AND @to::date) ""collections"",
 (SELECT COALESCE(SUM(""Balance""),0) FROM ""vCustomerBalances"" WHERE ""BusinessId"" = @b AND ""Balance"" > 0) ""receivables"",
 (SELECT COALESCE(SUM(""Balance""),0) FROM ""vSupplierBalances"" WHERE ""BusinessId"" = @b AND ""Balance"" > 0) ""payables"",
 (SELECT COALESCE(SUM(""Balance""),0) FROM ""vCashBalances"" WHERE ""BusinessId"" = @b AND ""Kind"" = 'CASH') ""cashInHand"",
 (SELECT COALESCE(SUM(""Balance""),0) FROM ""vCashBalances"" WHERE ""BusinessId"" = @b AND ""Kind"" <> 'CASH') ""bankAndWallet"",
 (SELECT count(*) FROM ""DeliveryStops"" s JOIN ""Deliveries"" d ON d.""Id"" = s.""DeliveryId"" WHERE d.""BusinessId"" = @b AND s.""Status"" = 'PENDING') ""pendingDeliveries"",
 (SELECT count(*) FROM ""SalesReturns"" WHERE ""BusinessId"" = @b AND (""ReturnDate"" AT TIME ZONE 'Asia/Karachi')::date BETWEEN @from::date AND @to::date) ""returnsCount"",
 (SELECT count(*) FROM ""SyncConflicts"" WHERE ""BusinessId"" = @b AND ""Status"" = 'OPEN') ""openConflicts"",
 (SELECT COALESCE(SUM(f.""Packets"" * v.""AvgUnitCost""),0) FROM ""vFinishedStock"" f JOIN ""ProductVariations"" v ON v.""Id"" = f.""VariationId"" WHERE f.""BusinessId"" = @b AND f.""Packets"" > 0)
  + (SELECT COALESCE(SUM(bs.""Grams"" * bt.""UnitCostPerGram""),0) FROM ""vBulkStock"" bs JOIN ""Batches"" bt ON bt.""Id"" = bs.""BatchId"" WHERE bs.""BusinessId"" = @b AND bs.""Grams"" > 0)
  + (SELECT COALESCE(SUM(ms.""Quantity"" * m.""AvgUnitCost""),0) FROM ""vMaterialStock"" ms JOIN ""PackagingMaterials"" m ON m.""Id"" = ms.""MaterialId"" WHERE ms.""BusinessId"" = @b AND ms.""Quantity"" > 0) ""stockValue""", p);

        var trend = await c.QueryAsync(@"
SELECT d::date ""date"", COALESCE(SUM(i.""Total""),0) ""sales"", count(i.""Id"") ""invoices""
FROM generate_series(@from::date, @to::date, interval '1 day') d
LEFT JOIN ""SalesInvoices"" i ON i.""BusinessId"" = @b AND i.""Status"" = 'POSTED' AND (i.""InvoiceDate"" AT TIME ZONE 'Asia/Karachi')::date = d::date
GROUP BY d ORDER BY d", p);

        var topProducts = await c.QueryAsync(@"
SELECT pr.""Name"" ""name"", pr.""NameUr"" ""nameUr"", SUM(l.""Quantity"") ""packets"", SUM(l.""Quantity"" * l.""PacketGrams"") ""grams"", SUM(l.""LineTotal"") ""amount""
FROM ""SalesInvoiceLines"" l JOIN ""SalesInvoices"" i ON i.""Id"" = l.""InvoiceId"" JOIN ""Products"" pr ON pr.""Id"" = l.""ProductId""
WHERE i.""BusinessId"" = @b AND i.""Status"" = 'POSTED' AND (i.""InvoiceDate"" AT TIME ZONE 'Asia/Karachi')::date BETWEEN @from::date AND @to::date
GROUP BY pr.""Name"", pr.""NameUr"" ORDER BY ""amount"" DESC LIMIT 5", p);

        var topCustomers = await c.QueryAsync(@"
SELECT cu.""ShopName"" ""name"", cu.""Area"" ""area"", SUM(i.""Total"") ""amount"", count(*) ""invoices""
FROM ""SalesInvoices"" i JOIN ""Customers"" cu ON cu.""Id"" = i.""CustomerId""
WHERE i.""BusinessId"" = @b AND i.""Status"" = 'POSTED' AND (i.""InvoiceDate"" AT TIME ZONE 'Asia/Karachi')::date BETWEEN @from::date AND @to::date
GROUP BY cu.""ShopName"", cu.""Area"" ORDER BY ""amount"" DESC LIMIT 5", p);

        var lowStock = await LowStockAsync(c);
        var expiring = await c.QueryAsync(@"
SELECT p.""Name"" ""product"", p.""NameUr"" ""productUr"", b.""BatchNo"" ""batchNo"", b.""ExpiryDate"" ""expiryDate"", bs.""Grams"" ""grams"",
       (b.""ExpiryDate"" < (now() AT TIME ZONE 'Asia/Karachi')::date) ""expired""
FROM ""vBulkStock"" bs JOIN ""Batches"" b ON b.""Id"" = bs.""BatchId"" JOIN ""Products"" p ON p.""Id"" = b.""ProductId""
WHERE bs.""BusinessId"" = @b AND bs.""Grams"" > 0 AND b.""ExpiryDate"" IS NOT NULL
  AND b.""ExpiryDate"" <= (now() AT TIME ZONE 'Asia/Karachi')::date + 30
ORDER BY b.""ExpiryDate""", p);

        var activity = await c.QueryAsync(@"
SELECT a.""OccurredAt"" ""at"", a.""Action"" ""action"", a.""EntityType"" ""entityType"", a.""Summary"" ""summary"", u.""FullName"" ""user""
FROM ""AuditLogs"" a LEFT JOIN ""Users"" u ON u.""Id"" = a.""UserId""
WHERE a.""BusinessId"" = @b AND a.""Action"" NOT IN ('LOGIN') ORDER BY a.""OccurredAt"" DESC LIMIT 12", p);

        return new { profit, totals, trend, topProducts, topCustomers, lowStock, expiring, activity };
    }

    private async Task<IEnumerable<dynamic>> LowStockAsync(NpgsqlConnection c) => await c.QueryAsync(@"
SELECT 'BULK' ""kind"", p.""Id"" ""id"", p.""Name"" ""name"", p.""NameUr"" ""nameUr"", NULL::int ""packetGrams"",
       COALESCE(SUM(bs.""Grams""),0) ""quantity"", p.""MinStockGrams"" ""minimum"", 'g' ""unit""
FROM ""Products"" p LEFT JOIN ""vBulkStock"" bs ON bs.""ProductId"" = p.""Id""
WHERE p.""BusinessId"" = @b AND p.""IsActive"" AND p.""MinStockGrams"" > 0
GROUP BY p.""Id"" HAVING COALESCE(SUM(bs.""Grams""),0) < p.""MinStockGrams""
UNION ALL
SELECT 'FINISHED', v.""Id"", p.""Name"", p.""NameUr"", v.""PacketGrams"", COALESCE(f.""Packets"",0), v.""MinStockPackets"", 'pkt'
FROM ""ProductVariations"" v JOIN ""Products"" p ON p.""Id"" = v.""ProductId"" LEFT JOIN ""vFinishedStock"" f ON f.""VariationId"" = v.""Id""
WHERE v.""BusinessId"" = @b AND v.""IsActive"" AND v.""MinStockPackets"" > 0 AND COALESCE(f.""Packets"",0) < v.""MinStockPackets""
UNION ALL
SELECT 'MATERIAL', m.""Id"", m.""Name"", m.""NameUr"", NULL, ms.""Quantity"", m.""MinStock"", m.""Unit""
FROM ""PackagingMaterials"" m JOIN ""vMaterialStock"" ms ON ms.""MaterialId"" = m.""Id""
WHERE m.""BusinessId"" = @b AND m.""IsActive"" AND m.""MinStock"" > 0 AND ms.""Quantity"" < m.""MinStock""
ORDER BY 1, 3", new { b = _user.BusinessId });

    public async Task<object> ProfitAndLossAsync(DateOnly? from, DateOnly? to)
    {
        await using var c = await _ds.OpenConnectionAsync();
        var p = P(from, to);
        var summary = await c.QuerySingleAsync(ProfitSql, p);
        var expenses = await c.QueryAsync(@"
SELECT ""Category"" ""category"", SUM(""Amount"") ""amount"", count(*) ""count"" FROM ""Expenses""
WHERE ""BusinessId"" = @b AND ""Status"" = 'POSTED' AND (""ExpenseDate"" AT TIME ZONE 'Asia/Karachi')::date BETWEEN @from::date AND @to::date
GROUP BY ""Category"" ORDER BY ""amount"" DESC", p);
        return new
        {
            summary, expenses, method = "Weighted-average cost (packet cost includes spice, packaging, loss and any labour/overhead entered on packing orders).",
            provisional = true
        };
    }

    // ------------------------------------------------------------------ sales
    public async Task<IEnumerable<dynamic>> SalesSummaryAsync(string groupBy, DateOnly? from, DateOnly? to)
    {
        var (key, label, joins) = groupBy switch
        {
            "product" => ("pr.\"Id\"", "pr.\"Name\" \"label\", pr.\"NameUr\" \"labelUr\"", "JOIN \"Products\" pr ON pr.\"Id\" = l.\"ProductId\""),
            "variation" => ("l.\"VariationId\"", "pr.\"Name\" || ' ' || l.\"PacketGrams\" || ' g' \"label\", pr.\"NameUr\" \"labelUr\"", "JOIN \"Products\" pr ON pr.\"Id\" = l.\"ProductId\""),
            "size" => ("l.\"PacketGrams\"", "l.\"PacketGrams\" || ' g' \"label\", NULL \"labelUr\"", ""),
            "customer" => ("cu.\"Id\"", "cu.\"ShopName\" \"label\", cu.\"Area\" \"labelUr\"", "JOIN \"Customers\" cu ON cu.\"Id\" = i.\"CustomerId\""),
            "area" => ("COALESCE(cu.\"Area\", '-')", "COALESCE(cu.\"Area\", '-') \"label\", NULL \"labelUr\"", "JOIN \"Customers\" cu ON cu.\"Id\" = i.\"CustomerId\""),
            "salesperson" => ("u.\"Id\"", "COALESCE(u.\"FullName\", '-') \"label\", NULL \"labelUr\"", "LEFT JOIN \"Users\" u ON u.\"Id\" = i.\"SalespersonId\""),
            "payment" => ("i.\"PaymentMethod\"", "i.\"PaymentMethod\" \"label\", NULL \"labelUr\"", ""),
            "day" => ("(i.\"InvoiceDate\" AT TIME ZONE 'Asia/Karachi')::date", "to_char((i.\"InvoiceDate\" AT TIME ZONE 'Asia/Karachi')::date, 'YYYY-MM-DD') \"label\", NULL \"labelUr\"", ""),
            "month" => ("date_trunc('month', i.\"InvoiceDate\" AT TIME ZONE 'Asia/Karachi')", "to_char(date_trunc('month', i.\"InvoiceDate\" AT TIME ZONE 'Asia/Karachi'), 'YYYY-MM') \"label\", NULL \"labelUr\"", ""),
            _ => throw new AppException("bad_group", "Unknown grouping.")
        };
        var sql = $@"
SELECT {label}, count(DISTINCT i.""Id"") ""invoices"", SUM(l.""Quantity"") ""packets"", SUM(l.""Quantity"" * l.""PacketGrams"") ""grams"",
       SUM(l.""DiscountAmount"") ""discounts"", SUM(l.""LineTotal"") ""amount"", SUM(l.""Quantity"" * l.""UnitCost"") ""cost"",
       SUM(l.""LineTotal"" - l.""TaxAmount"") - SUM(l.""Quantity"" * l.""UnitCost"") ""grossProfit"",
       SUM(l.""ReturnedQty"") ""returnedPackets""
FROM ""SalesInvoiceLines"" l JOIN ""SalesInvoices"" i ON i.""Id"" = l.""InvoiceId"" {joins}
WHERE i.""BusinessId"" = @b AND i.""Status"" = 'POSTED' AND (i.""InvoiceDate"" AT TIME ZONE 'Asia/Karachi')::date BETWEEN @from::date AND @to::date
GROUP BY {key}, 1, 2 ORDER BY ""amount"" DESC";
        await using var c = await _ds.OpenConnectionAsync();
        return await c.QueryAsync(sql, P(from, to));
    }

    // ------------------------------------------------------------------ inventory
    public async Task<object> StockAsync()
    {
        await using var c = await _ds.OpenConnectionAsync();
        var p = new { b = _user.BusinessId };
        var bulk = await c.QueryAsync(@"
SELECT p.""Id"" ""productId"", p.""Code"" ""code"", p.""Name"" ""name"", p.""NameUr"" ""nameUr"", b.""Id"" ""batchId"", b.""BatchNo"" ""batchNo"",
       b.""ReceivedAt"" ""receivedAt"", b.""ExpiryDate"" ""expiryDate"", b.""ReceivedGrams"" ""receivedGrams"", bs.""Grams"" ""grams"",
       b.""UnitCostPerGram"" * 1000 ""costPerKg"", ROUND(bs.""Grams"" * b.""UnitCostPerGram"", 2) ""value""
FROM ""vBulkStock"" bs JOIN ""Batches"" b ON b.""Id"" = bs.""BatchId"" JOIN ""Products"" p ON p.""Id"" = bs.""ProductId""
WHERE bs.""BusinessId"" = @b AND bs.""Grams"" <> 0 ORDER BY p.""Name"", b.""ReceivedAt""", p);
        var finished = await c.QueryAsync(@"
SELECT v.""Id"" ""variationId"", p.""Id"" ""productId"", p.""Name"" ""name"", p.""NameUr"" ""nameUr"", p.""ImageUrl"" ""imageUrl"", v.""Sku"" ""sku"", v.""PacketGrams"" ""packetGrams"",
       COALESCE(f.""Packets"",0) ""packets"", COALESCE(d.""Packets"",0) ""damaged"", v.""AvgUnitCost"" ""avgCost"", v.""RetailPrice"" ""retailPrice"",
       ROUND(GREATEST(COALESCE(f.""Packets"",0),0) * v.""AvgUnitCost"", 2) ""value"", v.""MinStockPackets"" ""minimum""
FROM ""ProductVariations"" v JOIN ""Products"" p ON p.""Id"" = v.""ProductId""
LEFT JOIN ""vFinishedStock"" f ON f.""VariationId"" = v.""Id""
LEFT JOIN (SELECT ""VariationId"", SUM(""Quantity"") ""Packets"" FROM ""vDamagedStock"" WHERE ""Unit"" = 'PKT' GROUP BY ""VariationId"") d ON d.""VariationId"" = v.""Id""
WHERE v.""BusinessId"" = @b AND (v.""IsActive"" OR COALESCE(f.""Packets"",0) <> 0) ORDER BY p.""Name"", v.""PacketGrams""", p);
        var materials = await c.QueryAsync(@"
SELECT m.""Id"" ""materialId"", m.""Code"" ""code"", m.""Name"" ""name"", m.""NameUr"" ""nameUr"", m.""Kind"" ""kind"", m.""Unit"" ""unit"",
       ms.""Quantity"" ""quantity"", m.""MinStock"" ""minimum"", m.""AvgUnitCost"" ""avgCost"", ROUND(GREATEST(ms.""Quantity"",0) * m.""AvgUnitCost"", 2) ""value""
FROM ""PackagingMaterials"" m JOIN ""vMaterialStock"" ms ON ms.""MaterialId"" = m.""Id""
WHERE m.""BusinessId"" = @b ORDER BY m.""Kind"", m.""Name""", p);
        var lowStock = await LowStockAsync(c);
        return new { bulk, finished, materials, lowStock };
    }

    public async Task<object> StockLedgerAsync(string bucket, Guid? productId, Guid? variationId, Guid? batchId, Guid? materialId, DateOnly? from, DateOnly? to, int page, int pageSize)
    {
        pageSize = Math.Clamp(pageSize, 10, 500); page = Math.Max(page, 1);
        await using var c = await _ds.OpenConnectionAsync();
        var p = P(from, to, new { productId, variationId, batchId, materialId, bucket = NormalizeBucket(bucket), limit = pageSize, offset = (page - 1) * pageSize });
        string sql, countSql, openingSql;
        if (bucket.Equals("MATERIAL", StringComparison.OrdinalIgnoreCase))
        {
            const string where = @"WHERE t.""BusinessId"" = @b AND (@materialId::uuid IS NULL OR t.""MaterialId"" = @materialId)";
            openingSql = $@"SELECT COALESCE(SUM(t.""Quantity""),0) FROM ""PackagingMaterialTransactions"" t {where} AND (t.""OccurredAt"" AT TIME ZONE 'Asia/Karachi')::date < @from::date";
            countSql = $@"SELECT count(*) FROM ""PackagingMaterialTransactions"" t {where} AND (t.""OccurredAt"" AT TIME ZONE 'Asia/Karachi')::date BETWEEN @from::date AND @to::date";
            sql = $@"SELECT t.""OccurredAt"" ""at"", m.""Name"" ""item"", t.""MovementType"" ""type"", t.""Quantity"" ""quantity"", t.""UnitCost"" ""unitCost"",
                       t.""SourceType"" ""sourceType"", t.""SourceId"" ""sourceId"", t.""Reason"" ""reason"", u.""FullName"" ""user"",
                       SUM(t.""Quantity"") OVER (ORDER BY t.""OccurredAt"", t.""CreatedAt"", t.""Id"") ""runningInPeriod""
                FROM ""PackagingMaterialTransactions"" t JOIN ""PackagingMaterials"" m ON m.""Id"" = t.""MaterialId"" LEFT JOIN ""Users"" u ON u.""Id"" = t.""CreatedBy""
                {where} AND (t.""OccurredAt"" AT TIME ZONE 'Asia/Karachi')::date BETWEEN @from::date AND @to::date
                ORDER BY t.""OccurredAt"", t.""CreatedAt"", t.""Id"" LIMIT @limit OFFSET @offset";
        }
        else
        {
            const string where = @"WHERE t.""BusinessId"" = @b AND t.""Bucket"" = @bucket
                AND (@productId::uuid IS NULL OR t.""ProductId"" = @productId) AND (@variationId::uuid IS NULL OR t.""VariationId"" = @variationId)
                AND (@batchId::uuid IS NULL OR t.""BatchId"" = @batchId)";
            openingSql = $@"SELECT COALESCE(SUM(t.""Quantity""),0) FROM ""InventoryTransactions"" t {where} AND (t.""OccurredAt"" AT TIME ZONE 'Asia/Karachi')::date < @from::date";
            countSql = $@"SELECT count(*) FROM ""InventoryTransactions"" t {where} AND (t.""OccurredAt"" AT TIME ZONE 'Asia/Karachi')::date BETWEEN @from::date AND @to::date";
            sql = $@"SELECT t.""OccurredAt"" ""at"", p.""Name"" || COALESCE(' ' || v.""PacketGrams"" || ' g', '') ""item"", b.""BatchNo"" ""batchNo"", t.""Unit"" ""unit"",
                       t.""MovementType"" ""type"", t.""Quantity"" ""quantity"", t.""UnitCost"" ""unitCost"", t.""SourceType"" ""sourceType"", t.""SourceId"" ""sourceId"",
                       t.""Reason"" ""reason"", u.""FullName"" ""user"",
                       SUM(t.""Quantity"") OVER (ORDER BY t.""OccurredAt"", t.""CreatedAt"", t.""Id"") ""runningInPeriod""
                FROM ""InventoryTransactions"" t JOIN ""Products"" p ON p.""Id"" = t.""ProductId""
                LEFT JOIN ""ProductVariations"" v ON v.""Id"" = t.""VariationId"" LEFT JOIN ""Batches"" b ON b.""Id"" = t.""BatchId""
                LEFT JOIN ""Users"" u ON u.""Id"" = t.""CreatedBy""
                {where} AND (t.""OccurredAt"" AT TIME ZONE 'Asia/Karachi')::date BETWEEN @from::date AND @to::date
                ORDER BY t.""OccurredAt"", t.""CreatedAt"", t.""Id"" LIMIT @limit OFFSET @offset";
        }
        var opening = await c.ExecuteScalarAsync<long>(openingSql, p);
        var total = await c.ExecuteScalarAsync<int>(countSql, p);
        var rows = await c.QueryAsync(sql, p);
        return new { opening, total, page, pageSize, rows };
    }

    private static string NormalizeBucket(string bucket) => (bucket ?? "").Trim().ToUpperInvariant();

    // ------------------------------------------------------------------ statements & aging
    public async Task<object> CustomerStatementAsync(Guid customerId, DateOnly? from, DateOnly? to)
    {
        await using var c = await _ds.OpenConnectionAsync();
        var p = P(from, to, new { id = customerId });
        var customer = await c.QuerySingleOrDefaultAsync(@"SELECT ""Id"" ""id"", ""Code"" ""code"", ""ShopName"" ""shopName"", ""Phone"" ""phone"", ""Address"" ""address"", ""Area"" ""area"", ""CreditLimit"" ""creditLimit""
            FROM ""Customers"" WHERE ""Id"" = @id AND ""BusinessId"" = @b", p) ?? throw AppException.NotFound("Customer");
        var opening = await c.ExecuteScalarAsync<decimal>(@"SELECT COALESCE(SUM(""Debit"" - ""Credit""),0) FROM ""CustomerLedgerEntries""
            WHERE ""CustomerId"" = @id AND (""EntryDate"" AT TIME ZONE 'Asia/Karachi')::date < @from::date", p);
        var rows = await c.QueryAsync(@"
SELECT e.""EntryDate"" ""date"", e.""EntryType"" ""type"", e.""Description"" ""description"", e.""Debit"" ""debit"", e.""Credit"" ""credit"",
       e.""SourceType"" ""sourceType"", e.""SourceId"" ""sourceId"",
       @opening + SUM(e.""Debit"" - e.""Credit"") OVER (ORDER BY e.""EntryDate"", e.""CreatedAt"", e.""Id"") ""balance""
FROM ""CustomerLedgerEntries"" e
WHERE e.""CustomerId"" = @id AND (e.""EntryDate"" AT TIME ZONE 'Asia/Karachi')::date BETWEEN @from::date AND @to::date
ORDER BY e.""EntryDate"", e.""CreatedAt"", e.""Id""", new DynamicParameters(p).Merge(new { opening }));
        var closing = await c.ExecuteScalarAsync<decimal>(@"SELECT COALESCE(SUM(""Debit"" - ""Credit""),0) FROM ""CustomerLedgerEntries""
            WHERE ""CustomerId"" = @id AND (""EntryDate"" AT TIME ZONE 'Asia/Karachi')::date <= @to::date", p);
        return new { customer, opening, rows, closing };
    }

    public async Task<object> SupplierStatementAsync(Guid supplierId, DateOnly? from, DateOnly? to)
    {
        await using var c = await _ds.OpenConnectionAsync();
        var p = P(from, to, new { id = supplierId });
        var supplier = await c.QuerySingleOrDefaultAsync(@"SELECT ""Id"" ""id"", ""Code"" ""code"", ""Name"" ""name"", ""Phone"" ""phone"", ""Address"" ""address""
            FROM ""Suppliers"" WHERE ""Id"" = @id AND ""BusinessId"" = @b", p) ?? throw AppException.NotFound("Supplier");
        var opening = await c.ExecuteScalarAsync<decimal>(@"SELECT COALESCE(SUM(""Credit"" - ""Debit""),0) FROM ""SupplierLedgerEntries""
            WHERE ""SupplierId"" = @id AND (""EntryDate"" AT TIME ZONE 'Asia/Karachi')::date < @from::date", p);
        var rows = await c.QueryAsync(@"
SELECT e.""EntryDate"" ""date"", e.""EntryType"" ""type"", e.""Description"" ""description"", e.""Debit"" ""debit"", e.""Credit"" ""credit"",
       @opening + SUM(e.""Credit"" - e.""Debit"") OVER (ORDER BY e.""EntryDate"", e.""CreatedAt"", e.""Id"") ""balance""
FROM ""SupplierLedgerEntries"" e
WHERE e.""SupplierId"" = @id AND (e.""EntryDate"" AT TIME ZONE 'Asia/Karachi')::date BETWEEN @from::date AND @to::date
ORDER BY e.""EntryDate"", e.""CreatedAt"", e.""Id""", new DynamicParameters(p).Merge(new { opening }));
        var closing = await c.ExecuteScalarAsync<decimal>(@"SELECT COALESCE(SUM(""Credit"" - ""Debit""),0) FROM ""SupplierLedgerEntries""
            WHERE ""SupplierId"" = @id AND (""EntryDate"" AT TIME ZONE 'Asia/Karachi')::date <= @to::date", p);
        return new { supplier, opening, rows, closing };
    }

    public async Task<IEnumerable<dynamic>> AgingAsync()
    {
        await using var c = await _ds.OpenConnectionAsync();
        return await c.QueryAsync(@"
WITH open AS (
  SELECT o.""CustomerId"", o.""OpenAmount"", ((now() AT TIME ZONE 'Asia/Karachi')::date - (o.""InvoiceDate"" AT TIME ZONE 'Asia/Karachi')::date) age
  FROM ""vInvoiceOpenAmounts"" o WHERE o.""BusinessId"" = @b AND o.""OpenAmount"" > 0)
SELECT cu.""Id"" ""customerId"", cu.""Code"" ""code"", cu.""ShopName"" ""shopName"", cu.""Area"" ""area"", cu.""Phone"" ""phone"", cu.""CreditLimit"" ""creditLimit"",
       COALESCE(SUM(CASE WHEN age <= 30 THEN ""OpenAmount"" END),0) ""d0_30"",
       COALESCE(SUM(CASE WHEN age BETWEEN 31 AND 60 THEN ""OpenAmount"" END),0) ""d31_60"",
       COALESCE(SUM(CASE WHEN age BETWEEN 61 AND 90 THEN ""OpenAmount"" END),0) ""d61_90"",
       COALESCE(SUM(CASE WHEN age > 90 THEN ""OpenAmount"" END),0) ""d90plus"",
       COALESCE(SUM(""OpenAmount""),0) ""openInvoices"", bal.""Balance"" ""ledgerBalance""
FROM ""Customers"" cu
JOIN ""vCustomerBalances"" bal ON bal.""CustomerId"" = cu.""Id""
LEFT JOIN open ON open.""CustomerId"" = cu.""Id""
WHERE cu.""BusinessId"" = @b
GROUP BY cu.""Id"", bal.""Balance""
HAVING COALESCE(SUM(""OpenAmount""),0) <> 0 OR bal.""Balance"" <> 0
ORDER BY ""ledgerBalance"" DESC", new { b = _user.BusinessId });
    }

    // ------------------------------------------------------------------ cash
    public async Task<object> CashBookAsync(Guid? accountId, DateOnly? from, DateOnly? to)
    {
        await using var c = await _ds.OpenConnectionAsync();
        var p = P(from, to, new { acc = accountId });
        var accounts = await c.QueryAsync(@"
SELECT a.""Id"" ""accountId"", a.""Name"" ""name"", a.""NameUr"" ""nameUr"", a.""Kind"" ""kind"",
  a.""OpeningBalance"" + COALESCE((SELECT SUM(""Amount"") FROM ""CashTransactions"" t WHERE t.""AccountId"" = a.""Id"" AND (t.""OccurredAt"" AT TIME ZONE 'Asia/Karachi')::date < @from::date),0) ""opening"",
  COALESCE((SELECT SUM(""Amount"") FROM ""CashTransactions"" t WHERE t.""AccountId"" = a.""Id"" AND ""Amount"" > 0 AND (t.""OccurredAt"" AT TIME ZONE 'Asia/Karachi')::date BETWEEN @from::date AND @to::date),0) ""moneyIn"",
  COALESCE((SELECT -SUM(""Amount"") FROM ""CashTransactions"" t WHERE t.""AccountId"" = a.""Id"" AND ""Amount"" < 0 AND (t.""OccurredAt"" AT TIME ZONE 'Asia/Karachi')::date BETWEEN @from::date AND @to::date),0) ""moneyOut"",
  a.""OpeningBalance"" + COALESCE((SELECT SUM(""Amount"") FROM ""CashTransactions"" t WHERE t.""AccountId"" = a.""Id"" AND (t.""OccurredAt"" AT TIME ZONE 'Asia/Karachi')::date <= @to::date),0) ""closing""
FROM ""CashAccounts"" a WHERE a.""BusinessId"" = @b AND (@acc::uuid IS NULL OR a.""Id"" = @acc) ORDER BY a.""Kind"", a.""Name""", p);
        var rows = await c.QueryAsync(@"
SELECT t.""OccurredAt"" ""at"", a.""Name"" ""account"", t.""SourceType"" ""type"", t.""Description"" ""description"",
       CASE WHEN t.""Amount"" > 0 THEN t.""Amount"" ELSE 0 END ""moneyIn"", CASE WHEN t.""Amount"" < 0 THEN -t.""Amount"" ELSE 0 END ""moneyOut"",
       u.""FullName"" ""user""
FROM ""CashTransactions"" t JOIN ""CashAccounts"" a ON a.""Id"" = t.""AccountId"" LEFT JOIN ""Users"" u ON u.""Id"" = t.""CreatedBy""
WHERE t.""BusinessId"" = @b AND (@acc::uuid IS NULL OR t.""AccountId"" = @acc)
  AND (t.""OccurredAt"" AT TIME ZONE 'Asia/Karachi')::date BETWEEN @from::date AND @to::date
ORDER BY t.""OccurredAt"", t.""CreatedAt"" LIMIT 2000", p);
        return new { accounts, rows };
    }

    // ------------------------------------------------------------------ purchasing / packing / delivery / expenses
    public async Task<IEnumerable<dynamic>> PurchasesSummaryAsync(string groupBy, DateOnly? from, DateOnly? to)
    {
        var sql = groupBy == "product"
            ? @"SELECT COALESCE(p.""Name"", m.""Name"") ""label"", COALESCE(p.""NameUr"", m.""NameUr"") ""labelUr"", l.""LineType"" ""type"",
                       SUM(l.""Quantity"") ""quantity"", SUM(l.""LineTotal"" + l.""LandedCost"") ""amount"",
                       ROUND(SUM(l.""LineTotal"" + l.""LandedCost"") / NULLIF(SUM(l.""Quantity""),0) * CASE WHEN l.""LineType"" = 'SPICE' THEN 1000 ELSE 1 END, 2) ""avgRate""
                FROM ""PurchaseLines"" l JOIN ""Purchases"" pu ON pu.""Id"" = l.""PurchaseId""
                LEFT JOIN ""Products"" p ON p.""Id"" = l.""ProductId"" LEFT JOIN ""PackagingMaterials"" m ON m.""Id"" = l.""MaterialId""
                WHERE pu.""BusinessId"" = @b AND pu.""Status"" = 'POSTED' AND pu.""PurchaseDate"" BETWEEN @from::date AND @to::date
                GROUP BY 1, 2, 3 ORDER BY ""amount"" DESC"
            : @"SELECT s.""Name"" ""label"", NULL ""labelUr"", count(*) ""purchases"", SUM(pu.""Total"") ""amount"", SUM(pu.""AmountPaid"") ""paidAtPurchase"",
                       (SELECT ""Balance"" FROM ""vSupplierBalances"" sb WHERE sb.""SupplierId"" = s.""Id"") ""currentBalance""
                FROM ""Purchases"" pu JOIN ""Suppliers"" s ON s.""Id"" = pu.""SupplierId""
                WHERE pu.""BusinessId"" = @b AND pu.""Status"" = 'POSTED' AND pu.""PurchaseDate"" BETWEEN @from::date AND @to::date
                GROUP BY s.""Id"", s.""Name"" ORDER BY ""amount"" DESC";
        await using var c = await _ds.OpenConnectionAsync();
        return await c.QueryAsync(sql, P(from, to));
    }

    public async Task<IEnumerable<dynamic>> PriceHistoryAsync(Guid productId)
    {
        await using var c = await _ds.OpenConnectionAsync();
        return await c.QueryAsync(@"
SELECT pu.""PurchaseDate"" ""date"", pu.""PurchaseNo"" ""purchaseNo"", s.""Name"" ""supplier"", l.""Quantity"" ""grams"", l.""Rate"" ""ratePerKg"",
       ROUND((l.""LineTotal"" + l.""LandedCost"") / l.""Quantity"" * 1000, 2) ""landedPerKg"", l.""BatchNo"" ""batchNo""
FROM ""PurchaseLines"" l JOIN ""Purchases"" pu ON pu.""Id"" = l.""PurchaseId"" JOIN ""Suppliers"" s ON s.""Id"" = pu.""SupplierId""
WHERE pu.""BusinessId"" = @b AND l.""ProductId"" = @productId AND pu.""Status"" = 'POSTED'
ORDER BY pu.""PurchaseDate"" DESC LIMIT 200", new { b = _user.BusinessId, productId });
    }

    public async Task<IEnumerable<dynamic>> PackingReportAsync(DateOnly? from, DateOnly? to)
    {
        await using var c = await _ds.OpenConnectionAsync();
        return await c.QueryAsync(@"
SELECT o.""OrderNo"" ""orderNo"", o.""PackDate"" ""packDate"", p.""Name"" ""product"", p.""NameUr"" ""productUr"", v.""PacketGrams"" ""packetGrams"",
       b.""BatchNo"" ""batchNo"", o.""PlannedPackets"" ""planned"", o.""ProducedPackets"" ""produced"", o.""RejectedPackets"" ""rejected"",
       o.""LossGrams"" ""lossGrams"", o.""ConsumedGrams"" ""consumedGrams"", o.""PouchesUsed"" ""pouchesUsed"", o.""LabelsUsed"" ""labelsUsed"",
       ROUND(100.0 * o.""ProducedPackets"" * v.""PacketGrams"" / NULLIF(o.""ConsumedGrams"",0), 2) ""yieldPercent"",
       o.""SpiceCost"" ""spiceCost"", o.""MaterialCost"" ""materialCost"", o.""LabourCost"" + o.""OverheadCost"" ""otherCost"",
       o.""TotalCost"" ""totalCost"", o.""UnitCost"" ""unitCost"", u.""FullName"" ""postedBy""
FROM ""PackingOrders"" o JOIN ""Products"" p ON p.""Id"" = o.""ProductId"" JOIN ""ProductVariations"" v ON v.""Id"" = o.""VariationId""
JOIN ""Batches"" b ON b.""Id"" = o.""BatchId"" LEFT JOIN ""Users"" u ON u.""Id"" = o.""PostedBy""
WHERE o.""BusinessId"" = @b AND o.""Status"" = 'POSTED' AND o.""PackDate"" BETWEEN @from::date AND @to::date
ORDER BY o.""PackDate"", o.""OrderNo""", P(from, to));
    }

    public async Task<IEnumerable<dynamic>> DeliveryReportAsync(DateOnly? from, DateOnly? to)
    {
        await using var c = await _ds.OpenConnectionAsync();
        return await c.QueryAsync(@"
SELECT d.""Id"" ""deliveryId"", d.""DeliveryNo"" ""deliveryNo"", d.""DeliveryDate"" ""date"", r.""Name"" ""route"", u.""FullName"" ""assignedTo"", d.""Status"" ""status"",
       count(s.""Id"") ""stops"",
       count(s.""Id"") FILTER (WHERE s.""Status"" = 'DELIVERED') ""delivered"",
       count(s.""Id"") FILTER (WHERE s.""Status"" = 'PARTIAL') ""partial"",
       count(s.""Id"") FILTER (WHERE s.""Status"" = 'FAILED') ""failed"",
       count(s.""Id"") FILTER (WHERE s.""Status"" = 'PENDING') ""pending"",
       COALESCE(SUM(s.""ExpectedCollection""),0) ""expected"", COALESCE(SUM(s.""CollectedAmount""),0) ""collected"",
       (SELECT COALESCE(SUM(""Amount""),0) FROM ""Expenses"" e WHERE e.""DeliveryId"" = d.""Id"" AND e.""Status"" = 'POSTED') ""expenses""
FROM ""Deliveries"" d JOIN ""DeliveryRoutes"" r ON r.""Id"" = d.""RouteId"" JOIN ""Users"" u ON u.""Id"" = d.""AssignedUserId""
LEFT JOIN ""DeliveryStops"" s ON s.""DeliveryId"" = d.""Id""
WHERE d.""BusinessId"" = @b AND d.""DeliveryDate"" BETWEEN @from::date AND @to::date
GROUP BY d.""Id"", r.""Name"", u.""FullName"" ORDER BY d.""DeliveryDate"" DESC, d.""DeliveryNo""", P(from, to));
    }

    public async Task<object> DeliveryReconciliationAsync(Guid deliveryId)
    {
        await using var c = await _ds.OpenConnectionAsync();
        var p = new { b = _user.BusinessId, id = deliveryId };
        var header = await c.QuerySingleOrDefaultAsync(@"
SELECT d.""DeliveryNo"" ""deliveryNo"", d.""DeliveryDate"" ""date"", d.""Status"" ""status"", r.""Name"" ""route"", u.""FullName"" ""assignedTo"", d.""Vehicle"" ""vehicle""
FROM ""Deliveries"" d JOIN ""DeliveryRoutes"" r ON r.""Id"" = d.""RouteId"" JOIN ""Users"" u ON u.""Id"" = d.""AssignedUserId""
WHERE d.""Id"" = @id AND d.""BusinessId"" = @b", p) ?? throw AppException.NotFound("Delivery");
        var goods = await c.QueryAsync(@"
SELECT pr.""Name"" ""product"", pr.""NameUr"" ""productUr"", v.""PacketGrams"" ""packetGrams"",
       SUM(l.""LoadedQty"") ""loaded"", SUM(l.""DeliveredQty"") ""delivered"", SUM(l.""ReturnedQty"") ""returned"",
       SUM(CASE WHEN s.""Status"" = 'PENDING' THEN l.""LoadedQty"" ELSE 0 END) ""pending""
FROM ""DeliveryLines"" l JOIN ""DeliveryStops"" s ON s.""Id"" = l.""StopId"" JOIN ""ProductVariations"" v ON v.""Id"" = l.""VariationId""
JOIN ""Products"" pr ON pr.""Id"" = v.""ProductId""
WHERE s.""DeliveryId"" = @id GROUP BY pr.""Name"", pr.""NameUr"", v.""PacketGrams"" ORDER BY 1, 3", p);
        var money = await c.QuerySingleAsync(@"
SELECT COALESCE(SUM(s.""ExpectedCollection""),0) ""expected"", COALESCE(SUM(s.""CollectedAmount""),0) ""collected"",
       COALESCE(SUM(s.""ExpectedCollection""),0) - COALESCE(SUM(s.""CollectedAmount""),0) ""outstanding"",
       (SELECT COALESCE(SUM(""Amount""),0) FROM ""Expenses"" e WHERE e.""DeliveryId"" = @id AND e.""Status"" = 'POSTED') ""expenses""
FROM ""DeliveryStops"" s WHERE s.""DeliveryId"" = @id", p);
        return new { header, goods, money };
    }

    public async Task<IEnumerable<dynamic>> ExpenseSummaryAsync(DateOnly? from, DateOnly? to)
    {
        await using var c = await _ds.OpenConnectionAsync();
        return await c.QueryAsync(@"
SELECT ""Category"" ""category"", count(*) ""count"", SUM(""Amount"") ""amount""
FROM ""Expenses"" WHERE ""BusinessId"" = @b AND ""Status"" = 'POSTED'
  AND (""ExpenseDate"" AT TIME ZONE 'Asia/Karachi')::date BETWEEN @from::date AND @to::date
GROUP BY ""Category"" ORDER BY ""amount"" DESC", P(from, to));
    }
}

internal static class DynamicParametersExtensions
{
    public static DynamicParameters Merge(this DynamicParameters p, object extra)
    {
        p.AddDynamicParams(extra);
        return p;
    }
}
