// Entity classes map 1:1 to tables in database/schema.sql (PascalCase quoted identifiers).
namespace SpiceErp.Api.Data;

// ---------------------------------------------------------------- access
public class Business
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public string Name { get; set; } = "";
    public string? NameUr { get; set; }
    public string? Address { get; set; }
    public string? AddressUr { get; set; }
    public string? Phone { get; set; }
    public string? LogoUrl { get; set; }
    public string? InvoiceTerms { get; set; }
    public string? InvoiceTermsUr { get; set; }
    public string CurrencySymbol { get; set; } = "Rs.";
    public bool AllowNegativeStock { get; set; }
    public string CostingMethod { get; set; } = "WEIGHTED_AVERAGE";
    public string TimeZone { get; set; } = "Asia/Karachi";
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

public class Role
{
    public string Code { get; set; } = "";
    public string Name { get; set; } = "";
    public string NameUr { get; set; } = "";
}

public class User
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid BusinessId { get; set; }
    public string Username { get; set; } = "";
    public string FullName { get; set; } = "";
    public string? Phone { get; set; }
    public string PasswordHash { get; set; } = "";
    public string PreferredLanguage { get; set; } = "en";
    public bool IsActive { get; set; } = true;
    public int FailedLogins { get; set; }
    public DateTime? LockedUntil { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
    public List<UserRole> Roles { get; set; } = new();
}

public class UserRole
{
    public Guid UserId { get; set; }
    public string RoleCode { get; set; } = "";
}

public class Device
{
    public Guid Id { get; set; }
    public Guid BusinessId { get; set; }
    public string Name { get; set; } = "";
    public string Prefix { get; set; } = "";
    public Guid? LastUserId { get; set; }
    public bool IsRevoked { get; set; }
    public DateTime RegisteredAt { get; set; } = DateTime.UtcNow;
    public DateTime? LastSeenAt { get; set; }
    public DateTime? LastPushAt { get; set; }
    public DateTime? LastPullAt { get; set; }
}

public class UserDeviceAssignment
{
    public Guid UserId { get; set; }
    public Guid DeviceId { get; set; }
    public DateTime AssignedAt { get; set; } = DateTime.UtcNow;
}

public class DocumentSequence
{
    public Guid BusinessId { get; set; }
    public string DocType { get; set; } = "";
    public string Prefix { get; set; } = "";
    public long NextValue { get; set; } = 1;
}

// ---------------------------------------------------------------- catalogue
public class ProductCategory
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid BusinessId { get; set; }
    public string Name { get; set; } = "";
    public string? NameUr { get; set; }
    public bool IsActive { get; set; } = true;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

public class PackagingMaterial
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid BusinessId { get; set; }
    public string Code { get; set; } = "";
    public string Name { get; set; } = "";
    public string? NameUr { get; set; }
    public string Kind { get; set; } = "POUCH";
    public string Unit { get; set; } = "pcs";
    public long MinStock { get; set; }
    public decimal AvgUnitCost { get; set; }
    public bool IsActive { get; set; } = true;
    public int Version { get; set; } = 1;
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

public class Product
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid BusinessId { get; set; }
    public Guid? CategoryId { get; set; }
    public string Code { get; set; } = "";
    public string Name { get; set; } = "";
    public string? NameUr { get; set; }
    public string? SpiceType { get; set; }
    public string? Brand { get; set; }
    public string? Description { get; set; }
    public string? Barcode { get; set; }
    public long MinStockGrams { get; set; }
    public long ReorderGrams { get; set; }
    public bool TrackExpiry { get; set; }
    public decimal TaxRate { get; set; }
    public string? ImageUrl { get; set; }
    public bool IsActive { get; set; } = true;
    public int Version { get; set; } = 1;
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
    public List<ProductVariation> Variations { get; set; } = new();
}

public class ProductVariation
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid BusinessId { get; set; }
    public Guid ProductId { get; set; }
    public string Sku { get; set; } = "";
    public string? Barcode { get; set; }
    public int PacketGrams { get; set; }
    public decimal RetailPrice { get; set; }
    public decimal WholesalePrice { get; set; }
    public decimal? DealerPrice { get; set; }
    public decimal? MinPrice { get; set; }
    public int? TareGrams { get; set; }
    public Guid? PouchMaterialId { get; set; }
    public Guid? LabelMaterialId { get; set; }
    public int MinStockPackets { get; set; }
    public decimal AvgUnitCost { get; set; }
    public bool IsActive { get; set; } = true;
    public int Version { get; set; } = 1;
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

// ---------------------------------------------------------------- parties
public class Supplier
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid BusinessId { get; set; }
    public string Code { get; set; } = "";
    public string Name { get; set; } = "";
    public string? ContactPerson { get; set; }
    public string? Phone { get; set; }
    public string? Address { get; set; }
    public string? City { get; set; }
    public decimal OpeningBalance { get; set; }
    public string? Notes { get; set; }
    public bool IsActive { get; set; } = true;
    public int Version { get; set; } = 1;
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

public class DeliveryRoute
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid BusinessId { get; set; }
    public string Name { get; set; } = "";
    public string? Area { get; set; }
    public Guid? DefaultUserId { get; set; }
    public bool IsActive { get; set; } = true;
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

public class Customer
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid BusinessId { get; set; }
    public string Code { get; set; } = "";
    public string ShopName { get; set; } = "";
    public string? ContactPerson { get; set; }
    public string? Phone { get; set; }
    public string? WhatsApp { get; set; }
    public string? Address { get; set; }
    public string? Area { get; set; }
    public string? City { get; set; }
    public decimal? Latitude { get; set; }
    public decimal? Longitude { get; set; }
    public string CustomerType { get; set; } = "RETAILER";
    public Guid? SalespersonId { get; set; }
    public Guid? RouteId { get; set; }
    public decimal CreditLimit { get; set; }
    public int PaymentTermsDays { get; set; }
    public decimal OpeningBalance { get; set; }
    public string? Notes { get; set; }
    public bool IsActive { get; set; } = true;
    public int Version { get; set; } = 1;
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

public class CashAccount
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid BusinessId { get; set; }
    public string Name { get; set; } = "";
    public string? NameUr { get; set; }
    public string Kind { get; set; } = "CASH";
    public decimal OpeningBalance { get; set; }
    public bool IsActive { get; set; } = true;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

// ---------------------------------------------------------------- purchasing & stock
public class Purchase
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid BusinessId { get; set; }
    public string PurchaseNo { get; set; } = "";
    public Guid SupplierId { get; set; }
    public string? SupplierInvoiceNo { get; set; }
    public DateOnly PurchaseDate { get; set; }
    public string Status { get; set; } = "POSTED";
    public decimal SubTotal { get; set; }
    public decimal TransportCost { get; set; }
    public decimal DiscountAmount { get; set; }
    public decimal TaxAmount { get; set; }
    public decimal Total { get; set; }
    public decimal AmountPaid { get; set; }
    public Guid? PaymentAccountId { get; set; }
    public string? AttachmentUrl { get; set; }
    public string? Notes { get; set; }
    public Guid CreatedBy { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public Guid? CancelledBy { get; set; }
    public DateTime? CancelledAt { get; set; }
    public string? CancelReason { get; set; }
    public List<PurchaseLine> Lines { get; set; } = new();
}

public class PurchaseLine
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid PurchaseId { get; set; }
    public int LineNo { get; set; }
    public string LineType { get; set; } = "SPICE";
    public Guid? ProductId { get; set; }
    public Guid? MaterialId { get; set; }
    public string? BatchNo { get; set; }
    public long Quantity { get; set; }
    public decimal Rate { get; set; }
    public decimal LineTotal { get; set; }
    public decimal LandedCost { get; set; }
    public DateOnly? MfgDate { get; set; }
    public DateOnly? ExpiryDate { get; set; }
    public Guid? BatchId { get; set; }
}

public class Batch
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid BusinessId { get; set; }
    public Guid ProductId { get; set; }
    public string BatchNo { get; set; } = "";
    public Guid? SupplierId { get; set; }
    public Guid? PurchaseLineId { get; set; }
    public long ReceivedGrams { get; set; }
    public decimal UnitCostPerGram { get; set; }
    public DateOnly? MfgDate { get; set; }
    public DateOnly? ExpiryDate { get; set; }
    public DateTime ReceivedAt { get; set; } = DateTime.UtcNow;
    public bool IsClosed { get; set; }
}

public class InventoryTransaction
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid BusinessId { get; set; }
    public DateTime OccurredAt { get; set; }
    public string Bucket { get; set; } = "";
    public string Unit { get; set; } = "";
    public Guid ProductId { get; set; }
    public Guid? VariationId { get; set; }
    public Guid? BatchId { get; set; }
    public long Quantity { get; set; }
    public decimal UnitCost { get; set; }
    public string MovementType { get; set; } = "";
    public string SourceType { get; set; } = "";
    public Guid SourceId { get; set; }
    public string? Reason { get; set; }
    public Guid? CreatedBy { get; set; }
    public Guid? DeviceId { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}

public class PackagingMaterialTransaction
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid BusinessId { get; set; }
    public Guid MaterialId { get; set; }
    public DateTime OccurredAt { get; set; }
    public long Quantity { get; set; }
    public decimal UnitCost { get; set; }
    public string MovementType { get; set; } = "";
    public string SourceType { get; set; } = "";
    public Guid SourceId { get; set; }
    public string? Reason { get; set; }
    public Guid? CreatedBy { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}

public class StockAdjustment
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid BusinessId { get; set; }
    public string AdjustmentNo { get; set; } = "";
    public string Target { get; set; } = "";
    public Guid? ProductId { get; set; }
    public Guid? VariationId { get; set; }
    public Guid? BatchId { get; set; }
    public Guid? MaterialId { get; set; }
    public long QuantityDelta { get; set; }
    public string Reason { get; set; } = "";
    public Guid? ApprovedBy { get; set; }
    public Guid CreatedBy { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}

public class PackingOrder
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid BusinessId { get; set; }
    public string OrderNo { get; set; } = "";
    public Guid ProductId { get; set; }
    public Guid VariationId { get; set; }
    public Guid BatchId { get; set; }
    public DateOnly PackDate { get; set; }
    public int PlannedPackets { get; set; }
    public long PlannedGrams { get; set; }
    public string Status { get; set; } = "PLANNED";
    public Guid? AssignedToUserId { get; set; }
    public int ProducedPackets { get; set; }
    public int RejectedPackets { get; set; }
    public long LossGrams { get; set; }
    public long ConsumedGrams { get; set; }
    public long PouchesUsed { get; set; }
    public long LabelsUsed { get; set; }
    public decimal SpiceCost { get; set; }
    public decimal MaterialCost { get; set; }
    public decimal LabourCost { get; set; }
    public decimal OverheadCost { get; set; }
    public decimal TotalCost { get; set; }
    public decimal UnitCost { get; set; }
    public string? Notes { get; set; }
    public Guid CreatedBy { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public Guid? PostedBy { get; set; }
    public DateTime? PostedAt { get; set; }
    public Guid? CancelledBy { get; set; }
    public DateTime? CancelledAt { get; set; }
    public string? CancelReason { get; set; }
    public int Version { get; set; } = 1;
}

// ---------------------------------------------------------------- sales
public class SalesOrder
{
    public Guid Id { get; set; }
    public Guid BusinessId { get; set; }
    public string OrderNo { get; set; } = "";
    public Guid CustomerId { get; set; }
    public Guid? SalespersonId { get; set; }
    public DateTime OrderDate { get; set; }
    public string Status { get; set; } = "OPEN";
    public Guid? InvoiceId { get; set; }
    public string? Notes { get; set; }
    public Guid? DeviceId { get; set; }
    public Guid CreatedBy { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public List<SalesOrderLine> Lines { get; set; } = new();
}

public class SalesOrderLine
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid OrderId { get; set; }
    public Guid VariationId { get; set; }
    public int Quantity { get; set; }
    public decimal UnitPrice { get; set; }
}

public class SalesInvoice
{
    public Guid Id { get; set; }
    public Guid BusinessId { get; set; }
    public string InvoiceNo { get; set; } = "";
    public Guid? DeviceId { get; set; }
    public DateTime InvoiceDate { get; set; }
    public Guid CustomerId { get; set; }
    public Guid? SalespersonId { get; set; }
    public Guid? SalesOrderId { get; set; }
    public string Status { get; set; } = "POSTED";
    public string PaymentMethod { get; set; } = "CASH";
    public decimal SubTotal { get; set; }
    public decimal DiscountAmount { get; set; }
    public decimal TaxAmount { get; set; }
    public decimal Total { get; set; }
    public decimal PreviousBalance { get; set; }
    public decimal AmountPaid { get; set; }
    public decimal BalanceAfter { get; set; }
    public decimal CostTotal { get; set; }
    public decimal ReturnedAmount { get; set; }
    public string DeliveryStatus { get; set; } = "NOT_REQUIRED";
    public string? Notes { get; set; }
    public Guid CreatedBy { get; set; }
    public DateTime CreatedAt { get; set; }
    public DateTime ReceivedAt { get; set; } = DateTime.UtcNow;
    public Guid? CancelledBy { get; set; }
    public DateTime? CancelledAt { get; set; }
    public string? CancelReason { get; set; }
    public int Version { get; set; } = 1;
    public List<SalesInvoiceLine> Lines { get; set; } = new();
}

public class SalesInvoiceLine
{
    public Guid Id { get; set; }
    public Guid InvoiceId { get; set; }
    public int LineNo { get; set; }
    public Guid ProductId { get; set; }
    public Guid VariationId { get; set; }
    public string Description { get; set; } = "";
    public string? DescriptionUr { get; set; }
    public int PacketGrams { get; set; }
    public int Quantity { get; set; }
    public decimal ListPrice { get; set; }
    public decimal UnitPrice { get; set; }
    public decimal DiscountAmount { get; set; }
    public decimal TaxRate { get; set; }
    public decimal TaxAmount { get; set; }
    public decimal LineTotal { get; set; }
    public decimal UnitCost { get; set; }
    public int ReturnedQty { get; set; }
}

public class SalesReturn
{
    public Guid Id { get; set; }
    public Guid BusinessId { get; set; }
    public string ReturnNo { get; set; } = "";
    public Guid InvoiceId { get; set; }
    public Guid CustomerId { get; set; }
    public DateTime ReturnDate { get; set; }
    public string Origin { get; set; } = "MANUAL";
    public string Settlement { get; set; } = "CREDIT";
    public Guid? RefundAccountId { get; set; }
    public string? Reason { get; set; }
    public decimal Total { get; set; }
    public Guid? DeviceId { get; set; }
    public Guid CreatedBy { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public List<SalesReturnLine> Lines { get; set; } = new();
}

public class SalesReturnLine
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid ReturnId { get; set; }
    public Guid InvoiceLineId { get; set; }
    public Guid VariationId { get; set; }
    public int Quantity { get; set; }
    public decimal UnitPrice { get; set; }
    public decimal LineTotal { get; set; }
    public string Condition { get; set; } = "GOOD";
    public bool Restock { get; set; }
    public decimal UnitCost { get; set; }
}

// ---------------------------------------------------------------- money
public class CustomerReceipt
{
    public Guid Id { get; set; }
    public Guid BusinessId { get; set; }
    public string ReceiptNo { get; set; } = "";
    public Guid CustomerId { get; set; }
    public Guid? InvoiceId { get; set; }
    public DateTime ReceiptDate { get; set; }
    public decimal Amount { get; set; }
    public string Method { get; set; } = "CASH";
    public Guid AccountId { get; set; }
    public string? Reference { get; set; }
    public string? Notes { get; set; }
    public string Status { get; set; } = "POSTED";
    public Guid? DeviceId { get; set; }
    public Guid CreatedBy { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}

public class CustomerReceiptAllocation
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid ReceiptId { get; set; }
    public Guid InvoiceId { get; set; }
    public decimal Amount { get; set; }
}

public class SupplierPayment
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid BusinessId { get; set; }
    public string PaymentNo { get; set; } = "";
    public Guid SupplierId { get; set; }
    public Guid? PurchaseId { get; set; }
    public DateTime PaymentDate { get; set; }
    public decimal Amount { get; set; }
    public string Method { get; set; } = "CASH";
    public Guid AccountId { get; set; }
    public string? Reference { get; set; }
    public string? Notes { get; set; }
    public string Status { get; set; } = "POSTED";
    public Guid CreatedBy { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}

public class Expense
{
    public Guid Id { get; set; }
    public Guid BusinessId { get; set; }
    public string ExpenseNo { get; set; } = "";
    public DateTime ExpenseDate { get; set; }
    public string Category { get; set; } = "MISC";
    public decimal Amount { get; set; }
    public Guid AccountId { get; set; }
    public Guid? DeliveryId { get; set; }
    public string? Notes { get; set; }
    public string? AttachmentUrl { get; set; }
    public string Status { get; set; } = "POSTED";
    public Guid? DeviceId { get; set; }
    public Guid CreatedBy { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}

public class CashTransaction
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid BusinessId { get; set; }
    public Guid AccountId { get; set; }
    public DateTime OccurredAt { get; set; }
    public decimal Amount { get; set; }
    public string SourceType { get; set; } = "";
    public Guid SourceId { get; set; }
    public string? Description { get; set; }
    public Guid? CreatedBy { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}

public class CustomerLedgerEntry
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid BusinessId { get; set; }
    public Guid CustomerId { get; set; }
    public DateTime EntryDate { get; set; }
    public string EntryType { get; set; } = "";
    public decimal Debit { get; set; }
    public decimal Credit { get; set; }
    public string SourceType { get; set; } = "";
    public Guid SourceId { get; set; }
    public string? Description { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}

public class SupplierLedgerEntry
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid BusinessId { get; set; }
    public Guid SupplierId { get; set; }
    public DateTime EntryDate { get; set; }
    public string EntryType { get; set; } = "";
    public decimal Debit { get; set; }
    public decimal Credit { get; set; }
    public string SourceType { get; set; } = "";
    public Guid SourceId { get; set; }
    public string? Description { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}

// ---------------------------------------------------------------- delivery
public class Delivery
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid BusinessId { get; set; }
    public string DeliveryNo { get; set; } = "";
    public Guid RouteId { get; set; }
    public DateOnly DeliveryDate { get; set; }
    public Guid AssignedUserId { get; set; }
    public string? Vehicle { get; set; }
    public string Status { get; set; } = "PLANNED";
    public string? Notes { get; set; }
    public Guid CreatedBy { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime? CompletedAt { get; set; }
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
    public List<DeliveryStop> Stops { get; set; } = new();
}

public class DeliveryStop
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid DeliveryId { get; set; }
    public int Seq { get; set; }
    public Guid CustomerId { get; set; }
    public Guid? InvoiceId { get; set; }
    public string Status { get; set; } = "PENDING";
    public string? FailReason { get; set; }
    public decimal ExpectedCollection { get; set; }
    public decimal CollectedAmount { get; set; }
    public Guid? ReceiptId { get; set; }
    public Guid? ReturnId { get; set; }
    public string? AcknowledgedBy { get; set; }
    public string? Notes { get; set; }
    public DateOnly? NextVisitDate { get; set; }
    public DateTime? VisitedAt { get; set; }
    public int Version { get; set; } = 1;
    public List<DeliveryLine> Lines { get; set; } = new();
}

public class DeliveryLine
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid StopId { get; set; }
    public Guid InvoiceLineId { get; set; }
    public Guid VariationId { get; set; }
    public int LoadedQty { get; set; }
    public int DeliveredQty { get; set; }
    public int ReturnedQty { get; set; }
}

// ---------------------------------------------------------------- sync & audit
public class SyncBatch
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid BusinessId { get; set; }
    public Guid DeviceId { get; set; }
    public Guid UserId { get; set; }
    public DateTime ReceivedAt { get; set; } = DateTime.UtcNow;
    public int OperationCount { get; set; }
    public int AppliedCount { get; set; }
    public int DuplicateCount { get; set; }
    public int RejectedCount { get; set; }
    public int ConflictCount { get; set; }
}

public class ProcessedIdempotencyKey
{
    public Guid Key { get; set; }
    public Guid BusinessId { get; set; }
    public Guid? DeviceId { get; set; }
    public string OperationType { get; set; } = "";
    public string Status { get; set; } = "";
    public string ResultJson { get; set; } = "{}";
    public DateTime ProcessedAt { get; set; } = DateTime.UtcNow;
}

public class SyncConflict
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid BusinessId { get; set; }
    public Guid? DeviceId { get; set; }
    public Guid? OperationKey { get; set; }
    public string ConflictType { get; set; } = "";
    public string EntityType { get; set; } = "";
    public Guid? EntityId { get; set; }
    public string Details { get; set; } = "";
    public string Status { get; set; } = "OPEN";
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public Guid? ResolvedBy { get; set; }
    public DateTime? ResolvedAt { get; set; }
    public string? ResolutionNote { get; set; }
}

public class AuditLog
{
    public long Id { get; set; }
    public Guid BusinessId { get; set; }
    public Guid? UserId { get; set; }
    public Guid? DeviceId { get; set; }
    public string Action { get; set; } = "";
    public string EntityType { get; set; } = "";
    public string? EntityId { get; set; }
    public string Summary { get; set; } = "";
    public string? IpAddress { get; set; }
    public DateTime OccurredAt { get; set; } = DateTime.UtcNow;
}

public class ApplicationSetting
{
    public string Key { get; set; } = "";
    public string Value { get; set; } = "";
}
