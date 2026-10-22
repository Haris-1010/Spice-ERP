-- =====================================================================
--  Spice Business Management System — PostgreSQL schema (v1)
--  Target: PostgreSQL 14+   (uses gen_random_uuid(), built in since 13)
--
--  Conventions
--  * Table / column names are PascalCase and quoted so they map 1:1 to
--    the Entity Framework Core entities (Npgsql default naming).
--  * Bulk spice quantities are stored as INTEGER GRAMS (bigint).
--    Finished goods are stored as PACKETS (bigint).
--    Packaging materials are stored as UNITS (bigint).
--  * Money: numeric(14,2). Unit costs: numeric(18,6).
--  * All timestamps are timestamptz in UTC. The UI displays Asia/Karachi.
--  * Ledger tables are APPEND-ONLY (UPDATE/DELETE blocked by trigger).
--    Corrections are made with reversal rows, never by editing history.
--  * Costing policy: WEIGHTED AVERAGE for finished packets and packaging
--    materials; SPECIFIC BATCH cost for bulk spice consumed by packing.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- Helper: block UPDATE/DELETE on append-only ledgers
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_block_ledger_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Table % is append-only. Post a reversal entry instead.', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------
-- Business and access
-- ---------------------------------------------------------------------
CREATE TABLE "Businesses" (
  "Id"                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "Name"               text NOT NULL,
  "NameUr"             text,
  "Address"            text,
  "AddressUr"          text,
  "Phone"              text,
  "LogoUrl"            text,
  "InvoiceTerms"       text,
  "InvoiceTermsUr"     text,
  "CurrencySymbol"     text NOT NULL DEFAULT 'Rs.',
  "AllowNegativeStock" boolean NOT NULL DEFAULT false,
  "CostingMethod"      text NOT NULL DEFAULT 'WEIGHTED_AVERAGE',
  "TimeZone"           text NOT NULL DEFAULT 'Asia/Karachi',
  "CreatedAt"          timestamptz NOT NULL DEFAULT now(),
  "UpdatedAt"          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE "Roles" (
  "Code"   text PRIMARY KEY,           -- Owner, Storekeeper, Packer, Salesperson, Delivery, Accountant
  "Name"   text NOT NULL,
  "NameUr" text NOT NULL
);

CREATE TABLE "Users" (
  "Id"                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "BusinessId"        uuid NOT NULL REFERENCES "Businesses"("Id"),
  "Username"          text NOT NULL,
  "FullName"          text NOT NULL,
  "Phone"             text,
  "PasswordHash"      text NOT NULL,
  "PreferredLanguage" text NOT NULL DEFAULT 'en' CHECK ("PreferredLanguage" IN ('en','ur')),
  "IsActive"          boolean NOT NULL DEFAULT true,
  "FailedLogins"      integer NOT NULL DEFAULT 0,
  "LockedUntil"       timestamptz,
  "CreatedAt"         timestamptz NOT NULL DEFAULT now(),
  "UpdatedAt"         timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "UX_Users_Username" ON "Users"("BusinessId", lower("Username"));

CREATE TABLE "UserRoles" (
  "UserId"   uuid NOT NULL REFERENCES "Users"("Id") ON DELETE CASCADE,
  "RoleCode" text NOT NULL REFERENCES "Roles"("Code"),
  PRIMARY KEY ("UserId", "RoleCode")
);

CREATE TABLE "Devices" (
  "Id"           uuid PRIMARY KEY,                 -- generated on the device
  "BusinessId"   uuid NOT NULL REFERENCES "Businesses"("Id"),
  "Name"         text NOT NULL,
  "Prefix"       text NOT NULL,                    -- e.g. A1, used in offline document numbers
  "LastUserId"   uuid REFERENCES "Users"("Id"),
  "IsRevoked"    boolean NOT NULL DEFAULT false,
  "RegisteredAt" timestamptz NOT NULL DEFAULT now(),
  "LastSeenAt"   timestamptz,
  "LastPushAt"   timestamptz,
  "LastPullAt"   timestamptz
);
CREATE UNIQUE INDEX "UX_Devices_Prefix" ON "Devices"("BusinessId", "Prefix");

CREATE TABLE "UserDeviceAssignments" (
  "UserId"     uuid NOT NULL REFERENCES "Users"("Id") ON DELETE CASCADE,
  "DeviceId"   uuid NOT NULL REFERENCES "Devices"("Id") ON DELETE CASCADE,
  "AssignedAt" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("UserId", "DeviceId")
);

-- Server-side document number sequences (purchases, packing orders, etc.)
CREATE TABLE "DocumentSequences" (
  "BusinessId" uuid NOT NULL REFERENCES "Businesses"("Id"),
  "DocType"    text NOT NULL,
  "Prefix"     text NOT NULL,
  "NextValue"  bigint NOT NULL DEFAULT 1,
  PRIMARY KEY ("BusinessId", "DocType")
);

-- ---------------------------------------------------------------------
-- Products, variations, packaging materials
-- ---------------------------------------------------------------------
CREATE TABLE "ProductCategories" (
  "Id"         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "BusinessId" uuid NOT NULL REFERENCES "Businesses"("Id"),
  "Name"       text NOT NULL,
  "NameUr"     text,
  "IsActive"   boolean NOT NULL DEFAULT true,
  "UpdatedAt"  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "UX_ProductCategories_Name" ON "ProductCategories"("BusinessId", lower("Name"));

CREATE TABLE "PackagingMaterials" (
  "Id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "BusinessId"  uuid NOT NULL REFERENCES "Businesses"("Id"),
  "Code"        text NOT NULL,
  "Name"        text NOT NULL,
  "NameUr"      text,
  "Kind"        text NOT NULL CHECK ("Kind" IN ('POUCH','LABEL','WRAPPER','CARTON','SEALING','OTHER')),
  "Unit"        text NOT NULL DEFAULT 'pcs',
  "MinStock"    bigint NOT NULL DEFAULT 0,
  "AvgUnitCost" numeric(18,6) NOT NULL DEFAULT 0,
  "IsActive"    boolean NOT NULL DEFAULT true,
  "Version"     integer NOT NULL DEFAULT 1,
  "CreatedAt"   timestamptz NOT NULL DEFAULT now(),
  "UpdatedAt"   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "UX_PackagingMaterials_Code" ON "PackagingMaterials"("BusinessId", lower("Code"));

CREATE TABLE "Products" (
  "Id"            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "BusinessId"    uuid NOT NULL REFERENCES "Businesses"("Id"),
  "CategoryId"    uuid REFERENCES "ProductCategories"("Id"),
  "Code"          text NOT NULL,
  "Name"          text NOT NULL,
  "NameUr"        text,
  "SpiceType"     text,
  "Brand"         text,
  "Description"   text,
  "Barcode"       text,
  "MinStockGrams" bigint NOT NULL DEFAULT 0 CHECK ("MinStockGrams" >= 0),
  "ReorderGrams"  bigint NOT NULL DEFAULT 0 CHECK ("ReorderGrams" >= 0),
  "TrackExpiry"   boolean NOT NULL DEFAULT false,
  "TaxRate"       numeric(5,2) NOT NULL DEFAULT 0 CHECK ("TaxRate" >= 0),
  "ImageUrl"      text,
  "IsActive"      boolean NOT NULL DEFAULT true,
  "Version"       integer NOT NULL DEFAULT 1,
  "CreatedAt"     timestamptz NOT NULL DEFAULT now(),
  "UpdatedAt"     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "UX_Products_Code" ON "Products"("BusinessId", lower("Code"));
CREATE UNIQUE INDEX "UX_Products_Name" ON "Products"("BusinessId", lower("Name"));
CREATE INDEX "IX_Products_UpdatedAt" ON "Products"("BusinessId", "UpdatedAt");

CREATE TABLE "ProductVariations" (
  "Id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "BusinessId"      uuid NOT NULL REFERENCES "Businesses"("Id"),
  "ProductId"       uuid NOT NULL REFERENCES "Products"("Id"),
  "Sku"             text NOT NULL,
  "Barcode"         text,
  "PacketGrams"     integer NOT NULL CHECK ("PacketGrams" > 0),
  "RetailPrice"     numeric(14,2) NOT NULL CHECK ("RetailPrice" >= 0),
  "WholesalePrice"  numeric(14,2) NOT NULL CHECK ("WholesalePrice" >= 0),
  "DealerPrice"     numeric(14,2),
  "MinPrice"        numeric(14,2),
  "TareGrams"       integer,
  "PouchMaterialId" uuid REFERENCES "PackagingMaterials"("Id"),
  "LabelMaterialId" uuid REFERENCES "PackagingMaterials"("Id"),
  "MinStockPackets" integer NOT NULL DEFAULT 0,
  "AvgUnitCost"     numeric(18,6) NOT NULL DEFAULT 0,   -- weighted average cost per packet
  "IsActive"        boolean NOT NULL DEFAULT true,
  "Version"         integer NOT NULL DEFAULT 1,
  "CreatedAt"       timestamptz NOT NULL DEFAULT now(),
  "UpdatedAt"       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "UX_ProductVariations_Sku" ON "ProductVariations"("BusinessId", lower("Sku"));
CREATE UNIQUE INDEX "UX_ProductVariations_Size" ON "ProductVariations"("ProductId", "PacketGrams");
CREATE UNIQUE INDEX "UX_ProductVariations_Barcode" ON "ProductVariations"("BusinessId", "Barcode") WHERE "Barcode" IS NOT NULL;

-- ---------------------------------------------------------------------
-- Parties: suppliers, routes, customers
-- ---------------------------------------------------------------------
CREATE TABLE "Suppliers" (
  "Id"             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "BusinessId"     uuid NOT NULL REFERENCES "Businesses"("Id"),
  "Code"           text NOT NULL,
  "Name"           text NOT NULL,
  "ContactPerson"  text,
  "Phone"          text,
  "Address"        text,
  "City"           text,
  "OpeningBalance" numeric(14,2) NOT NULL DEFAULT 0,  -- positive = we owe the supplier
  "Notes"          text,
  "IsActive"       boolean NOT NULL DEFAULT true,
  "Version"        integer NOT NULL DEFAULT 1,
  "CreatedAt"      timestamptz NOT NULL DEFAULT now(),
  "UpdatedAt"      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "UX_Suppliers_Code" ON "Suppliers"("BusinessId", lower("Code"));

CREATE TABLE "DeliveryRoutes" (
  "Id"            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "BusinessId"    uuid NOT NULL REFERENCES "Businesses"("Id"),
  "Name"          text NOT NULL,
  "Area"          text,
  "DefaultUserId" uuid REFERENCES "Users"("Id"),
  "IsActive"      boolean NOT NULL DEFAULT true,
  "CreatedAt"     timestamptz NOT NULL DEFAULT now(),
  "UpdatedAt"     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "UX_DeliveryRoutes_Name" ON "DeliveryRoutes"("BusinessId", lower("Name"));

CREATE TABLE "Customers" (
  "Id"               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "BusinessId"       uuid NOT NULL REFERENCES "Businesses"("Id"),
  "Code"             text NOT NULL,
  "ShopName"         text NOT NULL,
  "ContactPerson"    text,
  "Phone"            text,
  "WhatsApp"         text,
  "Address"          text,
  "Area"             text,
  "City"             text,
  "Latitude"         numeric(9,6),
  "Longitude"        numeric(9,6),
  "CustomerType"     text NOT NULL DEFAULT 'RETAILER' CHECK ("CustomerType" IN ('RETAILER','WHOLESALER','DISTRIBUTOR')),
  "SalespersonId"    uuid REFERENCES "Users"("Id"),
  "RouteId"          uuid REFERENCES "DeliveryRoutes"("Id"),
  "CreditLimit"      numeric(14,2) NOT NULL DEFAULT 0,
  "PaymentTermsDays" integer NOT NULL DEFAULT 0,
  "OpeningBalance"   numeric(14,2) NOT NULL DEFAULT 0,  -- positive = customer owes us
  "Notes"            text,
  "IsActive"         boolean NOT NULL DEFAULT true,
  "Version"          integer NOT NULL DEFAULT 1,
  "CreatedAt"        timestamptz NOT NULL DEFAULT now(),
  "UpdatedAt"        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "UX_Customers_Code" ON "Customers"("BusinessId", lower("Code"));
CREATE INDEX "IX_Customers_Phone" ON "Customers"("BusinessId", "Phone");
CREATE INDEX "IX_Customers_Area" ON "Customers"("BusinessId", "Area");
CREATE INDEX "IX_Customers_UpdatedAt" ON "Customers"("BusinessId", "UpdatedAt");

-- ---------------------------------------------------------------------
-- Cash / bank / wallet accounts
-- ---------------------------------------------------------------------
CREATE TABLE "CashAccounts" (
  "Id"             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "BusinessId"     uuid NOT NULL REFERENCES "Businesses"("Id"),
  "Name"           text NOT NULL,
  "NameUr"         text,
  "Kind"           text NOT NULL CHECK ("Kind" IN ('CASH','BANK','WALLET')),
  "OpeningBalance" numeric(14,2) NOT NULL DEFAULT 0,
  "IsActive"       boolean NOT NULL DEFAULT true,
  "UpdatedAt"      timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- Purchases and batches
-- ---------------------------------------------------------------------
CREATE TABLE "Purchases" (
  "Id"                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "BusinessId"        uuid NOT NULL REFERENCES "Businesses"("Id"),
  "PurchaseNo"        text NOT NULL,
  "SupplierId"        uuid NOT NULL REFERENCES "Suppliers"("Id"),
  "SupplierInvoiceNo" text,
  "PurchaseDate"      date NOT NULL,
  "Status"            text NOT NULL DEFAULT 'POSTED' CHECK ("Status" IN ('POSTED','CANCELLED')),
  "SubTotal"          numeric(14,2) NOT NULL,
  "TransportCost"     numeric(14,2) NOT NULL DEFAULT 0,
  "DiscountAmount"    numeric(14,2) NOT NULL DEFAULT 0,
  "TaxAmount"         numeric(14,2) NOT NULL DEFAULT 0,
  "Total"             numeric(14,2) NOT NULL,
  "AmountPaid"        numeric(14,2) NOT NULL DEFAULT 0,
  "PaymentAccountId"  uuid REFERENCES "CashAccounts"("Id"),
  "AttachmentUrl"     text,
  "Notes"             text,
  "CreatedBy"         uuid NOT NULL REFERENCES "Users"("Id"),
  "CreatedAt"         timestamptz NOT NULL DEFAULT now(),
  "CancelledBy"       uuid REFERENCES "Users"("Id"),
  "CancelledAt"       timestamptz,
  "CancelReason"      text,
  CHECK ("AmountPaid" >= 0 AND "AmountPaid" <= "Total")
);
CREATE UNIQUE INDEX "UX_Purchases_No" ON "Purchases"("BusinessId", "PurchaseNo");
CREATE INDEX "IX_Purchases_Supplier" ON "Purchases"("SupplierId", "PurchaseDate");

CREATE TABLE "PurchaseLines" (
  "Id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "PurchaseId"  uuid NOT NULL REFERENCES "Purchases"("Id") ON DELETE CASCADE,
  "LineNo"      integer NOT NULL,
  "LineType"    text NOT NULL CHECK ("LineType" IN ('SPICE','MATERIAL')),
  "ProductId"   uuid REFERENCES "Products"("Id"),
  "MaterialId"  uuid REFERENCES "PackagingMaterials"("Id"),
  "BatchNo"     text,
  "Quantity"    bigint NOT NULL CHECK ("Quantity" > 0),   -- grams for SPICE, units for MATERIAL
  "Rate"        numeric(14,4) NOT NULL CHECK ("Rate" >= 0), -- per KG for SPICE, per unit for MATERIAL
  "LineTotal"   numeric(14,2) NOT NULL,
  "LandedCost"  numeric(14,2) NOT NULL DEFAULT 0,          -- allocated transport/tax - discount
  "MfgDate"     date,
  "ExpiryDate"  date,
  "BatchId"     uuid,
  CHECK (("LineType" = 'SPICE' AND "ProductId" IS NOT NULL) OR ("LineType" = 'MATERIAL' AND "MaterialId" IS NOT NULL))
);

CREATE TABLE "Batches" (
  "Id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "BusinessId"      uuid NOT NULL REFERENCES "Businesses"("Id"),
  "ProductId"       uuid NOT NULL REFERENCES "Products"("Id"),
  "BatchNo"         text NOT NULL,
  "SupplierId"      uuid REFERENCES "Suppliers"("Id"),
  "PurchaseLineId"  uuid REFERENCES "PurchaseLines"("Id"),
  "ReceivedGrams"   bigint NOT NULL CHECK ("ReceivedGrams" > 0),
  "UnitCostPerGram" numeric(18,6) NOT NULL,
  "MfgDate"         date,
  "ExpiryDate"      date,
  "ReceivedAt"      timestamptz NOT NULL DEFAULT now(),
  "IsClosed"        boolean NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX "UX_Batches_No" ON "Batches"("BusinessId", "ProductId", "BatchNo");
CREATE INDEX "IX_Batches_Expiry" ON "Batches"("BusinessId", "ExpiryDate") WHERE "ExpiryDate" IS NOT NULL;
ALTER TABLE "PurchaseLines" ADD CONSTRAINT "FK_PurchaseLines_Batch" FOREIGN KEY ("BatchId") REFERENCES "Batches"("Id");

-- ---------------------------------------------------------------------
-- Inventory ledger (append-only)
--   Bucket BULK      -> unit grams,   per batch
--   Bucket FINISHED  -> unit packets, per variation (saleable)
--   Bucket DAMAGED   -> unit packets or grams (rejected / damaged / expired)
-- ---------------------------------------------------------------------
CREATE TABLE "InventoryTransactions" (
  "Id"           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "BusinessId"   uuid NOT NULL REFERENCES "Businesses"("Id"),
  "OccurredAt"   timestamptz NOT NULL,
  "Bucket"       text NOT NULL CHECK ("Bucket" IN ('BULK','FINISHED','DAMAGED')),
  "Unit"         text NOT NULL CHECK ("Unit" IN ('G','PKT')),
  "ProductId"    uuid NOT NULL REFERENCES "Products"("Id"),
  "VariationId"  uuid REFERENCES "ProductVariations"("Id"),
  "BatchId"      uuid REFERENCES "Batches"("Id"),
  "Quantity"     bigint NOT NULL CHECK ("Quantity" <> 0),   -- signed: + in, - out
  "UnitCost"     numeric(18,6) NOT NULL DEFAULT 0,
  "MovementType" text NOT NULL,   -- PURCHASE, PURCHASE_CANCEL, PACK_CONSUME, PACK_PRODUCE, PACK_REJECT, SALE, SALE_CANCEL, SALE_RETURN, ADJUSTMENT, DAMAGE, OPENING, PACK_CANCEL
  "SourceType"   text NOT NULL,
  "SourceId"     uuid NOT NULL,
  "Reason"       text,
  "CreatedBy"    uuid REFERENCES "Users"("Id"),
  "DeviceId"     uuid,
  "CreatedAt"    timestamptz NOT NULL DEFAULT now(),
  CHECK ("Bucket" <> 'BULK' OR ("Unit" = 'G' AND "BatchId" IS NOT NULL)),
  CHECK ("Bucket" <> 'FINISHED' OR ("Unit" = 'PKT' AND "VariationId" IS NOT NULL))
);
CREATE INDEX "IX_InvTx_Bulk" ON "InventoryTransactions"("BusinessId", "Bucket", "ProductId", "BatchId");
CREATE INDEX "IX_InvTx_Variation" ON "InventoryTransactions"("VariationId", "Bucket");
CREATE INDEX "IX_InvTx_Source" ON "InventoryTransactions"("SourceType", "SourceId");
CREATE INDEX "IX_InvTx_Date" ON "InventoryTransactions"("BusinessId", "OccurredAt");
CREATE TRIGGER "TR_InvTx_AppendOnly" BEFORE UPDATE OR DELETE ON "InventoryTransactions"
  FOR EACH ROW EXECUTE FUNCTION fn_block_ledger_change();

CREATE TABLE "PackagingMaterialTransactions" (
  "Id"           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "BusinessId"   uuid NOT NULL REFERENCES "Businesses"("Id"),
  "MaterialId"   uuid NOT NULL REFERENCES "PackagingMaterials"("Id"),
  "OccurredAt"   timestamptz NOT NULL,
  "Quantity"     bigint NOT NULL CHECK ("Quantity" <> 0),
  "UnitCost"     numeric(18,6) NOT NULL DEFAULT 0,
  "MovementType" text NOT NULL,   -- PURCHASE, PACK_CONSUME, DAMAGE, ADJUSTMENT, OPENING, reversals
  "SourceType"   text NOT NULL,
  "SourceId"     uuid NOT NULL,
  "Reason"       text,
  "CreatedBy"    uuid REFERENCES "Users"("Id"),
  "CreatedAt"    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "IX_PkgTx_Material" ON "PackagingMaterialTransactions"("MaterialId", "OccurredAt");
CREATE INDEX "IX_PkgTx_Source" ON "PackagingMaterialTransactions"("SourceType", "SourceId");
CREATE TRIGGER "TR_PkgTx_AppendOnly" BEFORE UPDATE OR DELETE ON "PackagingMaterialTransactions"
  FOR EACH ROW EXECUTE FUNCTION fn_block_ledger_change();

CREATE TABLE "StockAdjustments" (
  "Id"           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "BusinessId"   uuid NOT NULL REFERENCES "Businesses"("Id"),
  "AdjustmentNo" text NOT NULL,
  "Target"       text NOT NULL CHECK ("Target" IN ('BULK','FINISHED','DAMAGED','MATERIAL')),
  "ProductId"    uuid REFERENCES "Products"("Id"),
  "VariationId"  uuid REFERENCES "ProductVariations"("Id"),
  "BatchId"      uuid REFERENCES "Batches"("Id"),
  "MaterialId"   uuid REFERENCES "PackagingMaterials"("Id"),
  "QuantityDelta" bigint NOT NULL CHECK ("QuantityDelta" <> 0),
  "Reason"       text NOT NULL,
  "ApprovedBy"   uuid REFERENCES "Users"("Id"),
  "CreatedBy"    uuid NOT NULL REFERENCES "Users"("Id"),
  "CreatedAt"    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "UX_StockAdjustments_No" ON "StockAdjustments"("BusinessId", "AdjustmentNo");

-- ---------------------------------------------------------------------
-- Packing / production
-- ---------------------------------------------------------------------
CREATE TABLE "PackingOrders" (
  "Id"               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "BusinessId"       uuid NOT NULL REFERENCES "Businesses"("Id"),
  "OrderNo"          text NOT NULL,
  "ProductId"        uuid NOT NULL REFERENCES "Products"("Id"),
  "VariationId"      uuid NOT NULL REFERENCES "ProductVariations"("Id"),
  "BatchId"          uuid NOT NULL REFERENCES "Batches"("Id"),
  "PackDate"         date NOT NULL,
  "PlannedPackets"   integer NOT NULL CHECK ("PlannedPackets" > 0),
  "PlannedGrams"     bigint NOT NULL CHECK ("PlannedGrams" > 0),
  "Status"           text NOT NULL DEFAULT 'PLANNED' CHECK ("Status" IN ('PLANNED','POSTED','CANCELLED')),
  "AssignedToUserId" uuid REFERENCES "Users"("Id"),
  -- actuals (filled when posted)
  "ProducedPackets"  integer NOT NULL DEFAULT 0 CHECK ("ProducedPackets" >= 0),
  "RejectedPackets"  integer NOT NULL DEFAULT 0 CHECK ("RejectedPackets" >= 0),
  "LossGrams"        bigint  NOT NULL DEFAULT 0 CHECK ("LossGrams" >= 0),
  "ConsumedGrams"    bigint  NOT NULL DEFAULT 0 CHECK ("ConsumedGrams" >= 0),
  "PouchesUsed"      bigint  NOT NULL DEFAULT 0,
  "LabelsUsed"       bigint  NOT NULL DEFAULT 0,
  "SpiceCost"        numeric(14,2) NOT NULL DEFAULT 0,
  "MaterialCost"     numeric(14,2) NOT NULL DEFAULT 0,
  "LabourCost"       numeric(14,2) NOT NULL DEFAULT 0,
  "OverheadCost"     numeric(14,2) NOT NULL DEFAULT 0,
  "TotalCost"        numeric(14,2) NOT NULL DEFAULT 0,
  "UnitCost"         numeric(18,6) NOT NULL DEFAULT 0,
  "Notes"            text,
  "CreatedBy"        uuid NOT NULL REFERENCES "Users"("Id"),
  "CreatedAt"        timestamptz NOT NULL DEFAULT now(),
  "PostedBy"         uuid REFERENCES "Users"("Id"),
  "PostedAt"         timestamptz,
  "CancelledBy"      uuid REFERENCES "Users"("Id"),
  "CancelledAt"      timestamptz,
  "CancelReason"     text,
  "Version"          integer NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX "UX_PackingOrders_No" ON "PackingOrders"("BusinessId", "OrderNo");
CREATE INDEX "IX_PackingOrders_Status" ON "PackingOrders"("BusinessId", "Status", "PackDate");

-- ---------------------------------------------------------------------
-- Sales
-- ---------------------------------------------------------------------
CREATE TABLE "SalesOrders" (
  "Id"            uuid PRIMARY KEY,
  "BusinessId"    uuid NOT NULL REFERENCES "Businesses"("Id"),
  "OrderNo"       text NOT NULL,
  "CustomerId"    uuid NOT NULL REFERENCES "Customers"("Id"),
  "SalespersonId" uuid REFERENCES "Users"("Id"),
  "OrderDate"     timestamptz NOT NULL,
  "Status"        text NOT NULL DEFAULT 'OPEN' CHECK ("Status" IN ('OPEN','INVOICED','CANCELLED')),
  "InvoiceId"     uuid,
  "Notes"         text,
  "DeviceId"      uuid,
  "CreatedBy"     uuid NOT NULL REFERENCES "Users"("Id"),
  "CreatedAt"     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "UX_SalesOrders_No" ON "SalesOrders"("BusinessId", "OrderNo");

CREATE TABLE "SalesOrderLines" (
  "Id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "OrderId"     uuid NOT NULL REFERENCES "SalesOrders"("Id") ON DELETE CASCADE,
  "VariationId" uuid NOT NULL REFERENCES "ProductVariations"("Id"),
  "Quantity"    integer NOT NULL CHECK ("Quantity" > 0),
  "UnitPrice"   numeric(14,2) NOT NULL
);

CREATE TABLE "SalesInvoices" (
  "Id"              uuid PRIMARY KEY,                 -- generated on the device (stable across sync)
  "BusinessId"      uuid NOT NULL REFERENCES "Businesses"("Id"),
  "InvoiceNo"       text NOT NULL,                    -- INV-<devicePrefix>-<seq>
  "DeviceId"        uuid REFERENCES "Devices"("Id"),
  "InvoiceDate"     timestamptz NOT NULL,
  "CustomerId"      uuid NOT NULL REFERENCES "Customers"("Id"),
  "SalespersonId"   uuid REFERENCES "Users"("Id"),
  "SalesOrderId"    uuid REFERENCES "SalesOrders"("Id"),
  "Status"          text NOT NULL DEFAULT 'POSTED' CHECK ("Status" IN ('POSTED','CANCELLED')),
  "PaymentMethod"   text NOT NULL CHECK ("PaymentMethod" IN ('CASH','CREDIT','BANK','WALLET')),
  "SubTotal"        numeric(14,2) NOT NULL,
  "DiscountAmount"  numeric(14,2) NOT NULL DEFAULT 0,
  "TaxAmount"       numeric(14,2) NOT NULL DEFAULT 0,
  "Total"           numeric(14,2) NOT NULL CHECK ("Total" >= 0),
  "PreviousBalance" numeric(14,2) NOT NULL DEFAULT 0,
  "AmountPaid"      numeric(14,2) NOT NULL DEFAULT 0 CHECK ("AmountPaid" >= 0),
  "BalanceAfter"    numeric(14,2) NOT NULL DEFAULT 0,
  "CostTotal"       numeric(14,2) NOT NULL DEFAULT 0,  -- COGS at posting (weighted average)
  "ReturnedAmount"  numeric(14,2) NOT NULL DEFAULT 0,
  "DeliveryStatus"  text NOT NULL DEFAULT 'NOT_REQUIRED' CHECK ("DeliveryStatus" IN ('NOT_REQUIRED','PENDING','DELIVERED','PARTIAL','FAILED')),
  "Notes"           text,
  "CreatedBy"       uuid NOT NULL REFERENCES "Users"("Id"),
  "CreatedAt"       timestamptz NOT NULL,             -- device time of creation
  "ReceivedAt"      timestamptz NOT NULL DEFAULT now(),-- server receipt time
  "CancelledBy"     uuid REFERENCES "Users"("Id"),
  "CancelledAt"     timestamptz,
  "CancelReason"    text,
  "Version"         integer NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX "UX_SalesInvoices_No" ON "SalesInvoices"("BusinessId", "InvoiceNo");
CREATE INDEX "IX_SalesInvoices_Date" ON "SalesInvoices"("BusinessId", "InvoiceDate");
CREATE INDEX "IX_SalesInvoices_Customer" ON "SalesInvoices"("CustomerId", "InvoiceDate");
CREATE INDEX "IX_SalesInvoices_Salesperson" ON "SalesInvoices"("SalespersonId", "InvoiceDate");
ALTER TABLE "SalesOrders" ADD CONSTRAINT "FK_SalesOrders_Invoice" FOREIGN KEY ("InvoiceId") REFERENCES "SalesInvoices"("Id");

CREATE TABLE "SalesInvoiceLines" (
  "Id"             uuid PRIMARY KEY,
  "InvoiceId"      uuid NOT NULL REFERENCES "SalesInvoices"("Id") ON DELETE CASCADE,
  "LineNo"         integer NOT NULL,
  "ProductId"      uuid NOT NULL REFERENCES "Products"("Id"),
  "VariationId"    uuid NOT NULL REFERENCES "ProductVariations"("Id"),
  "Description"    text NOT NULL,
  "DescriptionUr"  text,
  "PacketGrams"    integer NOT NULL,
  "Quantity"       integer NOT NULL CHECK ("Quantity" > 0),
  "ListPrice"      numeric(14,2) NOT NULL,
  "UnitPrice"      numeric(14,2) NOT NULL CHECK ("UnitPrice" >= 0),
  "DiscountAmount" numeric(14,2) NOT NULL DEFAULT 0,
  "TaxRate"        numeric(5,2) NOT NULL DEFAULT 0,
  "TaxAmount"      numeric(14,2) NOT NULL DEFAULT 0,
  "LineTotal"      numeric(14,2) NOT NULL,
  "UnitCost"       numeric(18,6) NOT NULL DEFAULT 0,
  "ReturnedQty"    integer NOT NULL DEFAULT 0 CHECK ("ReturnedQty" >= 0),
  CHECK ("ReturnedQty" <= "Quantity")
);
CREATE INDEX "IX_SalesInvoiceLines_Invoice" ON "SalesInvoiceLines"("InvoiceId");
CREATE INDEX "IX_SalesInvoiceLines_Variation" ON "SalesInvoiceLines"("VariationId");

CREATE TABLE "SalesReturns" (
  "Id"              uuid PRIMARY KEY,
  "BusinessId"      uuid NOT NULL REFERENCES "Businesses"("Id"),
  "ReturnNo"        text NOT NULL,
  "InvoiceId"       uuid NOT NULL REFERENCES "SalesInvoices"("Id"),
  "CustomerId"      uuid NOT NULL REFERENCES "Customers"("Id"),
  "ReturnDate"      timestamptz NOT NULL,
  "Origin"          text NOT NULL DEFAULT 'MANUAL' CHECK ("Origin" IN ('MANUAL','DELIVERY','CANCELLATION')),
  "Settlement"      text NOT NULL DEFAULT 'CREDIT' CHECK ("Settlement" IN ('CREDIT','CASH_REFUND')),
  "RefundAccountId" uuid REFERENCES "CashAccounts"("Id"),
  "Reason"          text,
  "Total"           numeric(14,2) NOT NULL,
  "DeviceId"        uuid,
  "CreatedBy"       uuid NOT NULL REFERENCES "Users"("Id"),
  "CreatedAt"       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "UX_SalesReturns_No" ON "SalesReturns"("BusinessId", "ReturnNo");
CREATE INDEX "IX_SalesReturns_Invoice" ON "SalesReturns"("InvoiceId");

CREATE TABLE "SalesReturnLines" (
  "Id"            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "ReturnId"      uuid NOT NULL REFERENCES "SalesReturns"("Id") ON DELETE CASCADE,
  "InvoiceLineId" uuid NOT NULL REFERENCES "SalesInvoiceLines"("Id"),
  "VariationId"   uuid NOT NULL REFERENCES "ProductVariations"("Id"),
  "Quantity"      integer NOT NULL CHECK ("Quantity" > 0),
  "UnitPrice"     numeric(14,4) NOT NULL,     -- net price per packet incl. discount/tax
  "LineTotal"     numeric(14,2) NOT NULL,
  "Condition"     text NOT NULL CHECK ("Condition" IN ('GOOD','DAMAGED','EXPIRED','WRONG_ITEM')),
  "Restock"       boolean NOT NULL,
  "UnitCost"      numeric(18,6) NOT NULL DEFAULT 0
);

-- ---------------------------------------------------------------------
-- Receipts, payments, expenses, ledgers
-- ---------------------------------------------------------------------
CREATE TABLE "CustomerReceipts" (
  "Id"          uuid PRIMARY KEY,
  "BusinessId"  uuid NOT NULL REFERENCES "Businesses"("Id"),
  "ReceiptNo"   text NOT NULL,
  "CustomerId"  uuid NOT NULL REFERENCES "Customers"("Id"),
  "InvoiceId"   uuid REFERENCES "SalesInvoices"("Id"),   -- preferred invoice for allocation
  "ReceiptDate" timestamptz NOT NULL,
  "Amount"      numeric(14,2) NOT NULL CHECK ("Amount" > 0),
  "Method"      text NOT NULL CHECK ("Method" IN ('CASH','BANK','WALLET')),
  "AccountId"   uuid NOT NULL REFERENCES "CashAccounts"("Id"),
  "Reference"   text,
  "Notes"       text,
  "Status"      text NOT NULL DEFAULT 'POSTED' CHECK ("Status" IN ('POSTED','CANCELLED')),
  "DeviceId"    uuid,
  "CreatedBy"   uuid NOT NULL REFERENCES "Users"("Id"),
  "CreatedAt"   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "UX_CustomerReceipts_No" ON "CustomerReceipts"("BusinessId", "ReceiptNo");
CREATE INDEX "IX_CustomerReceipts_Customer" ON "CustomerReceipts"("CustomerId", "ReceiptDate");

CREATE TABLE "CustomerReceiptAllocations" (
  "Id"        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "ReceiptId" uuid NOT NULL REFERENCES "CustomerReceipts"("Id") ON DELETE CASCADE,
  "InvoiceId" uuid NOT NULL REFERENCES "SalesInvoices"("Id"),
  "Amount"    numeric(14,2) NOT NULL CHECK ("Amount" > 0)
);
CREATE INDEX "IX_ReceiptAlloc_Invoice" ON "CustomerReceiptAllocations"("InvoiceId");

CREATE TABLE "SupplierPayments" (
  "Id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "BusinessId"  uuid NOT NULL REFERENCES "Businesses"("Id"),
  "PaymentNo"   text NOT NULL,
  "SupplierId"  uuid NOT NULL REFERENCES "Suppliers"("Id"),
  "PurchaseId"  uuid REFERENCES "Purchases"("Id"),
  "PaymentDate" timestamptz NOT NULL,
  "Amount"      numeric(14,2) NOT NULL CHECK ("Amount" > 0),
  "Method"      text NOT NULL CHECK ("Method" IN ('CASH','BANK','WALLET')),
  "AccountId"   uuid NOT NULL REFERENCES "CashAccounts"("Id"),
  "Reference"   text,
  "Notes"       text,
  "Status"      text NOT NULL DEFAULT 'POSTED' CHECK ("Status" IN ('POSTED','CANCELLED')),
  "CreatedBy"   uuid NOT NULL REFERENCES "Users"("Id"),
  "CreatedAt"   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "UX_SupplierPayments_No" ON "SupplierPayments"("BusinessId", "PaymentNo");

CREATE TABLE "Deliveries" (
  "Id"             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "BusinessId"     uuid NOT NULL REFERENCES "Businesses"("Id"),
  "DeliveryNo"     text NOT NULL,
  "RouteId"        uuid NOT NULL REFERENCES "DeliveryRoutes"("Id"),
  "DeliveryDate"   date NOT NULL,
  "AssignedUserId" uuid NOT NULL REFERENCES "Users"("Id"),
  "Vehicle"        text,
  "Status"         text NOT NULL DEFAULT 'PLANNED' CHECK ("Status" IN ('PLANNED','OUT','COMPLETED')),
  "Notes"          text,
  "CreatedBy"      uuid NOT NULL REFERENCES "Users"("Id"),
  "CreatedAt"      timestamptz NOT NULL DEFAULT now(),
  "CompletedAt"    timestamptz,
  "UpdatedAt"      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "UX_Deliveries_No" ON "Deliveries"("BusinessId", "DeliveryNo");
CREATE INDEX "IX_Deliveries_User" ON "Deliveries"("AssignedUserId", "DeliveryDate");

CREATE TABLE "DeliveryStops" (
  "Id"                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "DeliveryId"         uuid NOT NULL REFERENCES "Deliveries"("Id") ON DELETE CASCADE,
  "Seq"                integer NOT NULL,
  "CustomerId"         uuid NOT NULL REFERENCES "Customers"("Id"),
  "InvoiceId"          uuid REFERENCES "SalesInvoices"("Id"),
  "Status"             text NOT NULL DEFAULT 'PENDING' CHECK ("Status" IN ('PENDING','DELIVERED','PARTIAL','FAILED')),
  "FailReason"         text,
  "ExpectedCollection" numeric(14,2) NOT NULL DEFAULT 0,
  "CollectedAmount"    numeric(14,2) NOT NULL DEFAULT 0,
  "ReceiptId"          uuid REFERENCES "CustomerReceipts"("Id"),
  "ReturnId"           uuid REFERENCES "SalesReturns"("Id"),
  "AcknowledgedBy"     text,
  "Notes"              text,
  "NextVisitDate"      date,
  "VisitedAt"          timestamptz,
  "Version"            integer NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX "UX_DeliveryStops_Invoice" ON "DeliveryStops"("InvoiceId") WHERE "InvoiceId" IS NOT NULL;

CREATE TABLE "DeliveryLines" (
  "Id"            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "StopId"        uuid NOT NULL REFERENCES "DeliveryStops"("Id") ON DELETE CASCADE,
  "InvoiceLineId" uuid NOT NULL REFERENCES "SalesInvoiceLines"("Id"),
  "VariationId"   uuid NOT NULL REFERENCES "ProductVariations"("Id"),
  "LoadedQty"     integer NOT NULL CHECK ("LoadedQty" >= 0),
  "DeliveredQty"  integer NOT NULL DEFAULT 0 CHECK ("DeliveredQty" >= 0),
  "ReturnedQty"   integer NOT NULL DEFAULT 0 CHECK ("ReturnedQty" >= 0),
  CHECK ("DeliveredQty" + "ReturnedQty" <= "LoadedQty")
);

CREATE TABLE "Expenses" (
  "Id"            uuid PRIMARY KEY,
  "BusinessId"    uuid NOT NULL REFERENCES "Businesses"("Id"),
  "ExpenseNo"     text NOT NULL,
  "ExpenseDate"   timestamptz NOT NULL,
  "Category"      text NOT NULL CHECK ("Category" IN ('TRANSPORT','FUEL','RENT','SALARY','ELECTRICITY','PACKING_LABOUR','MAINTENANCE','MISC')),
  "Amount"        numeric(14,2) NOT NULL CHECK ("Amount" > 0),
  "AccountId"     uuid NOT NULL REFERENCES "CashAccounts"("Id"),
  "DeliveryId"    uuid REFERENCES "Deliveries"("Id"),
  "Notes"         text,
  "AttachmentUrl" text,
  "Status"        text NOT NULL DEFAULT 'POSTED' CHECK ("Status" IN ('POSTED','CANCELLED')),
  "DeviceId"      uuid,
  "CreatedBy"     uuid NOT NULL REFERENCES "Users"("Id"),
  "CreatedAt"     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "UX_Expenses_No" ON "Expenses"("BusinessId", "ExpenseNo");
CREATE INDEX "IX_Expenses_Date" ON "Expenses"("BusinessId", "ExpenseDate");

-- Cash book (append-only). Positive = money in, negative = money out.
CREATE TABLE "CashTransactions" (
  "Id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "BusinessId"  uuid NOT NULL REFERENCES "Businesses"("Id"),
  "AccountId"   uuid NOT NULL REFERENCES "CashAccounts"("Id"),
  "OccurredAt"  timestamptz NOT NULL,
  "Amount"      numeric(14,2) NOT NULL CHECK ("Amount" <> 0),
  "SourceType"  text NOT NULL,   -- RECEIPT, SUPPLIER_PAYMENT, EXPENSE, REFUND, TRANSFER, OPENING, *_CANCEL
  "SourceId"    uuid NOT NULL,
  "Description" text,
  "CreatedBy"   uuid REFERENCES "Users"("Id"),
  "CreatedAt"   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "IX_CashTx_Account" ON "CashTransactions"("AccountId", "OccurredAt");
CREATE INDEX "IX_CashTx_Source" ON "CashTransactions"("SourceType", "SourceId");
CREATE TRIGGER "TR_CashTx_AppendOnly" BEFORE UPDATE OR DELETE ON "CashTransactions"
  FOR EACH ROW EXECUTE FUNCTION fn_block_ledger_change();

-- Customer ledger: Debit increases what the customer owes; Credit decreases it.
CREATE TABLE "CustomerLedgerEntries" (
  "Id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "BusinessId"  uuid NOT NULL REFERENCES "Businesses"("Id"),
  "CustomerId"  uuid NOT NULL REFERENCES "Customers"("Id"),
  "EntryDate"   timestamptz NOT NULL,
  "EntryType"   text NOT NULL,  -- OPENING, INVOICE, RECEIPT, RETURN, CREDIT_NOTE, ADJUSTMENT, INVOICE_CANCEL, RECEIPT_CANCEL
  "Debit"       numeric(14,2) NOT NULL DEFAULT 0 CHECK ("Debit" >= 0),
  "Credit"      numeric(14,2) NOT NULL DEFAULT 0 CHECK ("Credit" >= 0),
  "SourceType"  text NOT NULL,
  "SourceId"    uuid NOT NULL,
  "Description" text,
  "CreatedAt"   timestamptz NOT NULL DEFAULT now(),
  CHECK ("Debit" > 0 OR "Credit" > 0)
);
CREATE INDEX "IX_CustLedger_Customer" ON "CustomerLedgerEntries"("CustomerId", "EntryDate");
CREATE UNIQUE INDEX "UX_CustLedger_Source" ON "CustomerLedgerEntries"("SourceType", "SourceId", "EntryType");
CREATE TRIGGER "TR_CustLedger_AppendOnly" BEFORE UPDATE OR DELETE ON "CustomerLedgerEntries"
  FOR EACH ROW EXECUTE FUNCTION fn_block_ledger_change();

-- Supplier ledger: Credit increases what we owe; Debit decreases it.
CREATE TABLE "SupplierLedgerEntries" (
  "Id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "BusinessId"  uuid NOT NULL REFERENCES "Businesses"("Id"),
  "SupplierId"  uuid NOT NULL REFERENCES "Suppliers"("Id"),
  "EntryDate"   timestamptz NOT NULL,
  "EntryType"   text NOT NULL,  -- OPENING, PURCHASE, PAYMENT, PURCHASE_CANCEL, PAYMENT_CANCEL, ADJUSTMENT
  "Debit"       numeric(14,2) NOT NULL DEFAULT 0 CHECK ("Debit" >= 0),
  "Credit"      numeric(14,2) NOT NULL DEFAULT 0 CHECK ("Credit" >= 0),
  "SourceType"  text NOT NULL,
  "SourceId"    uuid NOT NULL,
  "Description" text,
  "CreatedAt"   timestamptz NOT NULL DEFAULT now(),
  CHECK ("Debit" > 0 OR "Credit" > 0)
);
CREATE INDEX "IX_SuppLedger_Supplier" ON "SupplierLedgerEntries"("SupplierId", "EntryDate");
CREATE UNIQUE INDEX "UX_SuppLedger_Source" ON "SupplierLedgerEntries"("SourceType", "SourceId", "EntryType");
CREATE TRIGGER "TR_SuppLedger_AppendOnly" BEFORE UPDATE OR DELETE ON "SupplierLedgerEntries"
  FOR EACH ROW EXECUTE FUNCTION fn_block_ledger_change();

-- ---------------------------------------------------------------------
-- Synchronization and audit
-- ---------------------------------------------------------------------
CREATE TABLE "SyncBatches" (
  "Id"             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "BusinessId"     uuid NOT NULL REFERENCES "Businesses"("Id"),
  "DeviceId"       uuid NOT NULL REFERENCES "Devices"("Id"),
  "UserId"         uuid NOT NULL REFERENCES "Users"("Id"),
  "ReceivedAt"     timestamptz NOT NULL DEFAULT now(),
  "OperationCount" integer NOT NULL,
  "AppliedCount"   integer NOT NULL DEFAULT 0,
  "DuplicateCount" integer NOT NULL DEFAULT 0,
  "RejectedCount"  integer NOT NULL DEFAULT 0,
  "ConflictCount"  integer NOT NULL DEFAULT 0
);

-- Exactly-once processing: the key is inserted in the SAME transaction
-- that posts the business document. A retried operation finds its key and
-- receives the original result instead of creating a duplicate.
CREATE TABLE "ProcessedIdempotencyKeys" (
  "Key"           uuid PRIMARY KEY,
  "BusinessId"    uuid NOT NULL REFERENCES "Businesses"("Id"),
  "DeviceId"      uuid,
  "OperationType" text NOT NULL,
  "Status"        text NOT NULL,
  "ResultJson"    jsonb NOT NULL,
  "ProcessedAt"   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE "SyncConflicts" (
  "Id"             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "BusinessId"     uuid NOT NULL REFERENCES "Businesses"("Id"),
  "DeviceId"       uuid,
  "OperationKey"   uuid,
  "ConflictType"   text NOT NULL,   -- OVERSELL, PRICE_BELOW_MINIMUM, CREDIT_LIMIT, STALE_PRICE, REJECTED
  "EntityType"     text NOT NULL,
  "EntityId"       uuid,
  "Details"        text NOT NULL,
  "Status"         text NOT NULL DEFAULT 'OPEN' CHECK ("Status" IN ('OPEN','RESOLVED')),
  "CreatedAt"      timestamptz NOT NULL DEFAULT now(),
  "ResolvedBy"     uuid REFERENCES "Users"("Id"),
  "ResolvedAt"     timestamptz,
  "ResolutionNote" text
);
CREATE INDEX "IX_SyncConflicts_Open" ON "SyncConflicts"("BusinessId", "Status");

CREATE TABLE "AuditLogs" (
  "Id"         bigserial PRIMARY KEY,
  "BusinessId" uuid NOT NULL,
  "UserId"     uuid,
  "DeviceId"   uuid,
  "Action"     text NOT NULL,
  "EntityType" text NOT NULL,
  "EntityId"   text,
  "Summary"    text NOT NULL,
  "IpAddress"  text,
  "OccurredAt" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "IX_AuditLogs_Date" ON "AuditLogs"("BusinessId", "OccurredAt" DESC);
CREATE TRIGGER "TR_AuditLogs_AppendOnly" BEFORE UPDATE OR DELETE ON "AuditLogs"
  FOR EACH ROW EXECUTE FUNCTION fn_block_ledger_change();

CREATE TABLE "ApplicationSettings" (
  "Key"   text PRIMARY KEY,
  "Value" text NOT NULL
);

-- ---------------------------------------------------------------------
-- Convenience views (used by Dapper reports — single definition of stock)
-- ---------------------------------------------------------------------
CREATE VIEW "vBulkStock" AS
SELECT t."BusinessId", t."ProductId", t."BatchId", SUM(t."Quantity")::bigint AS "Grams"
FROM "InventoryTransactions" t
WHERE t."Bucket" = 'BULK'
GROUP BY t."BusinessId", t."ProductId", t."BatchId";

CREATE VIEW "vFinishedStock" AS
SELECT t."BusinessId", t."ProductId", t."VariationId", SUM(t."Quantity")::bigint AS "Packets"
FROM "InventoryTransactions" t
WHERE t."Bucket" = 'FINISHED'
GROUP BY t."BusinessId", t."ProductId", t."VariationId";

CREATE VIEW "vDamagedStock" AS
SELECT t."BusinessId", t."ProductId", t."VariationId", t."Unit", SUM(t."Quantity")::bigint AS "Quantity"
FROM "InventoryTransactions" t
WHERE t."Bucket" = 'DAMAGED'
GROUP BY t."BusinessId", t."ProductId", t."VariationId", t."Unit";

CREATE VIEW "vMaterialStock" AS
SELECT m."BusinessId", m."Id" AS "MaterialId", COALESCE(SUM(t."Quantity"), 0)::bigint AS "Quantity"
FROM "PackagingMaterials" m
LEFT JOIN "PackagingMaterialTransactions" t ON t."MaterialId" = m."Id"
GROUP BY m."BusinessId", m."Id";

CREATE VIEW "vCustomerBalances" AS
SELECT c."BusinessId", c."Id" AS "CustomerId",
       COALESCE(SUM(l."Debit" - l."Credit"), 0)::numeric(14,2) AS "Balance"
FROM "Customers" c
LEFT JOIN "CustomerLedgerEntries" l ON l."CustomerId" = c."Id"
GROUP BY c."BusinessId", c."Id";

CREATE VIEW "vSupplierBalances" AS
SELECT s."BusinessId", s."Id" AS "SupplierId",
       COALESCE(SUM(l."Credit" - l."Debit"), 0)::numeric(14,2) AS "Balance"
FROM "Suppliers" s
LEFT JOIN "SupplierLedgerEntries" l ON l."SupplierId" = s."Id"
GROUP BY s."BusinessId", s."Id";

CREATE VIEW "vCashBalances" AS
SELECT a."BusinessId", a."Id" AS "AccountId", a."Name", a."Kind",
       (a."OpeningBalance" + COALESCE(SUM(t."Amount"), 0))::numeric(14,2) AS "Balance"
FROM "CashAccounts" a
LEFT JOIN "CashTransactions" t ON t."AccountId" = a."Id"
GROUP BY a."BusinessId", a."Id", a."Name", a."Kind", a."OpeningBalance";

-- Open amount per invoice (for aging and allocation)
CREATE VIEW "vInvoiceOpenAmounts" AS
SELECT i."BusinessId", i."Id" AS "InvoiceId", i."CustomerId", i."InvoiceDate", i."InvoiceNo",
       (i."Total" - i."ReturnedAmount" - COALESCE(a."Allocated", 0))::numeric(14,2) AS "OpenAmount"
FROM "SalesInvoices" i
LEFT JOIN (SELECT ra."InvoiceId", SUM(ra."Amount") AS "Allocated"
           FROM "CustomerReceiptAllocations" ra
           JOIN "CustomerReceipts" r ON r."Id" = ra."ReceiptId" AND r."Status" = 'POSTED'
           GROUP BY ra."InvoiceId") a ON a."InvoiceId" = i."Id"
WHERE i."Status" = 'POSTED';

-- ---------------------------------------------------------------------
-- Reference data
-- ---------------------------------------------------------------------
INSERT INTO "Roles" ("Code","Name","NameUr") VALUES
 ('Owner','Owner / Administrator','مالک / منتظم'),
 ('Storekeeper','Storekeeper','اسٹور کیپر'),
 ('Packer','Packing Staff','پیکنگ عملہ'),
 ('Salesperson','Salesperson','سیلزمین'),
 ('Delivery','Delivery Person','ڈیلیوری والا'),
 ('Accountant','Accountant','اکاؤنٹنٹ');

INSERT INTO "ApplicationSettings" ("Key","Value") VALUES ('SchemaVersion','1');

COMMIT;
