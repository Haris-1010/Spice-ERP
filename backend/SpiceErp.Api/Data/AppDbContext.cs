using Microsoft.EntityFrameworkCore;

namespace SpiceErp.Api.Data;

/// <summary>
/// EF Core context for CRUD and transactional posting. Table names equal DbSet names and
/// column names equal property names, matching database/schema.sql exactly.
/// Reporting reads use Dapper against the same schema (see Reports/ReportQueries.cs).
/// </summary>
public class AppDbContext : DbContext
{
    public AppDbContext(DbContextOptions<AppDbContext> options) : base(options) { }

    public DbSet<Business> Businesses => Set<Business>();
    public DbSet<Role> Roles => Set<Role>();
    public DbSet<User> Users => Set<User>();
    public DbSet<UserRole> UserRoles => Set<UserRole>();
    public DbSet<Device> Devices => Set<Device>();
    public DbSet<UserDeviceAssignment> UserDeviceAssignments => Set<UserDeviceAssignment>();
    public DbSet<DocumentSequence> DocumentSequences => Set<DocumentSequence>();
    public DbSet<ProductCategory> ProductCategories => Set<ProductCategory>();
    public DbSet<PackagingMaterial> PackagingMaterials => Set<PackagingMaterial>();
    public DbSet<Product> Products => Set<Product>();
    public DbSet<ProductVariation> ProductVariations => Set<ProductVariation>();
    public DbSet<Supplier> Suppliers => Set<Supplier>();
    public DbSet<DeliveryRoute> DeliveryRoutes => Set<DeliveryRoute>();
    public DbSet<Customer> Customers => Set<Customer>();
    public DbSet<CashAccount> CashAccounts => Set<CashAccount>();
    public DbSet<Purchase> Purchases => Set<Purchase>();
    public DbSet<PurchaseLine> PurchaseLines => Set<PurchaseLine>();
    public DbSet<Batch> Batches => Set<Batch>();
    public DbSet<InventoryTransaction> InventoryTransactions => Set<InventoryTransaction>();
    public DbSet<PackagingMaterialTransaction> PackagingMaterialTransactions => Set<PackagingMaterialTransaction>();
    public DbSet<StockAdjustment> StockAdjustments => Set<StockAdjustment>();
    public DbSet<PackingOrder> PackingOrders => Set<PackingOrder>();
    public DbSet<SalesOrder> SalesOrders => Set<SalesOrder>();
    public DbSet<SalesOrderLine> SalesOrderLines => Set<SalesOrderLine>();
    public DbSet<SalesInvoice> SalesInvoices => Set<SalesInvoice>();
    public DbSet<SalesInvoiceLine> SalesInvoiceLines => Set<SalesInvoiceLine>();
    public DbSet<SalesReturn> SalesReturns => Set<SalesReturn>();
    public DbSet<SalesReturnLine> SalesReturnLines => Set<SalesReturnLine>();
    public DbSet<CustomerReceipt> CustomerReceipts => Set<CustomerReceipt>();
    public DbSet<CustomerReceiptAllocation> CustomerReceiptAllocations => Set<CustomerReceiptAllocation>();
    public DbSet<SupplierPayment> SupplierPayments => Set<SupplierPayment>();
    public DbSet<Expense> Expenses => Set<Expense>();
    public DbSet<CashTransaction> CashTransactions => Set<CashTransaction>();
    public DbSet<CustomerLedgerEntry> CustomerLedgerEntries => Set<CustomerLedgerEntry>();
    public DbSet<SupplierLedgerEntry> SupplierLedgerEntries => Set<SupplierLedgerEntry>();
    public DbSet<Delivery> Deliveries => Set<Delivery>();
    public DbSet<DeliveryStop> DeliveryStops => Set<DeliveryStop>();
    public DbSet<DeliveryLine> DeliveryLines => Set<DeliveryLine>();
    public DbSet<SyncBatch> SyncBatches => Set<SyncBatch>();
    public DbSet<ProcessedIdempotencyKey> ProcessedIdempotencyKeys => Set<ProcessedIdempotencyKey>();
    public DbSet<SyncConflict> SyncConflicts => Set<SyncConflict>();
    public DbSet<AuditLog> AuditLogs => Set<AuditLog>();
    public DbSet<ApplicationSetting> ApplicationSettings => Set<ApplicationSetting>();

    protected override void ConfigureConventions(ModelConfigurationBuilder builder)
    {
        builder.Properties<decimal>().HavePrecision(18, 6);
    }

    protected override void OnModelCreating(ModelBuilder b)
    {
        b.Entity<Role>().HasKey(x => x.Code);
        b.Entity<UserRole>().HasKey(x => new { x.UserId, x.RoleCode });
        b.Entity<UserDeviceAssignment>().HasKey(x => new { x.UserId, x.DeviceId });
        b.Entity<DocumentSequence>().HasKey(x => new { x.BusinessId, x.DocType });
        b.Entity<ProcessedIdempotencyKey>().HasKey(x => x.Key);
        b.Entity<ProcessedIdempotencyKey>().Property(x => x.ResultJson).HasColumnType("jsonb");
        b.Entity<ApplicationSetting>().HasKey(x => x.Key);
        b.Entity<Device>().Property(x => x.Id).ValueGeneratedNever();
        b.Entity<SalesInvoice>().Property(x => x.Id).ValueGeneratedNever();
        b.Entity<SalesInvoiceLine>().Property(x => x.Id).ValueGeneratedNever();
        b.Entity<SalesOrder>().Property(x => x.Id).ValueGeneratedNever();
        b.Entity<SalesReturn>().Property(x => x.Id).ValueGeneratedNever();
        b.Entity<CustomerReceipt>().Property(x => x.Id).ValueGeneratedNever();
        b.Entity<Expense>().Property(x => x.Id).ValueGeneratedNever();

        b.Entity<User>().HasMany(x => x.Roles).WithOne().HasForeignKey(x => x.UserId);
        b.Entity<Product>().HasMany(x => x.Variations).WithOne().HasForeignKey(x => x.ProductId);
        b.Entity<Purchase>().HasMany(x => x.Lines).WithOne().HasForeignKey(x => x.PurchaseId);
        b.Entity<SalesOrder>().HasMany(x => x.Lines).WithOne().HasForeignKey(x => x.OrderId);
        b.Entity<SalesInvoice>().HasMany(x => x.Lines).WithOne().HasForeignKey(x => x.InvoiceId);
        b.Entity<SalesReturn>().HasMany(x => x.Lines).WithOne().HasForeignKey(x => x.ReturnId);
        b.Entity<Delivery>().HasMany(x => x.Stops).WithOne().HasForeignKey(x => x.DeliveryId);
        b.Entity<DeliveryStop>().HasMany(x => x.Lines).WithOne().HasForeignKey(x => x.StopId);

        // Optimistic concurrency on frequently edited records.
        b.Entity<Product>().Property(x => x.Version).IsConcurrencyToken();
        b.Entity<ProductVariation>().Property(x => x.Version).IsConcurrencyToken();
        b.Entity<Customer>().Property(x => x.Version).IsConcurrencyToken();
        b.Entity<Supplier>().Property(x => x.Version).IsConcurrencyToken();
        b.Entity<PackingOrder>().Property(x => x.Version).IsConcurrencyToken();
        b.Entity<SalesInvoice>().Property(x => x.Version).IsConcurrencyToken();
        b.Entity<DeliveryStop>().Property(x => x.Version).IsConcurrencyToken();
    }
}
