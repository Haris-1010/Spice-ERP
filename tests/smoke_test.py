#!/usr/bin/env python3
"""
End-to-end acceptance test for the Spice ERP API (SRS section 25).

Usage:  python3 tests/smoke_test.py http://localhost:5080 admin <password>

Runs against a FRESH database seeded with the demo catalogue (Seed:DemoCatalog=true).
It creates real records: purchase, packing, sales, returns, receipts, delivery, sync.
"""
import json, sys, uuid, urllib.request, urllib.error, datetime

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:5080"
USER = sys.argv[2] if len(sys.argv) > 2 else "admin"
PWD = sys.argv[3] if len(sys.argv) > 3 else "Admin12345"
DEVICE = str(uuid.uuid4())
TOKEN = None
passed = 0


def call(method, path, body=None, expect=200):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if TOKEN:
        req.add_header("Authorization", "Bearer " + TOKEN)
    try:
        with urllib.request.urlopen(req) as r:
            status, raw = r.status, r.read()
    except urllib.error.HTTPError as e:
        status, raw = e.code, e.read()
    out = json.loads(raw) if raw else None
    if status != expect:
        raise AssertionError(f"{method} {path} -> {status} (expected {expect}): {raw[:600]}")
    return out


def check(cond, msg):
    global passed
    if not cond:
        raise AssertionError("FAILED: " + msg)
    passed += 1
    print("  ok  " + msg)


today = datetime.date.today().isoformat()
now = datetime.datetime.utcnow().isoformat() + "Z"

print("1. Login and device registration")
login = call("POST", "/api/auth/login", {"username": USER, "password": PWD, "deviceId": DEVICE, "deviceName": "Smoke test"})
TOKEN = login["token"]
prefix = login["device"]["prefix"]
check(prefix.startswith("D"), f"device prefix allocated ({prefix})")
call("POST", "/api/auth/login", {"username": USER, "password": "wrong", "deviceId": DEVICE}, expect=401)
check(True, "wrong password rejected")

products = call("GET", "/api/products?q=Black%20Pepper")["items"]
bp = products[0]
v50 = next(v for v in bp["variations"] if v["packetGrams"] == 50)
v20 = next(v for v in bp["variations"] if v["packetGrams"] == 20)
mats = call("GET", "/api/packaging-materials")
pouch50 = next(m for m in mats if m["code"] == "POUCH-50")
label = next(m for m in mats if m["code"] == "LABEL-STD")
accounts = call("GET", "/api/cash-accounts")
cash = next(a for a in accounts if a["kind"] == "CASH")

print("2. Supplier + purchase of 10 kg black pepper and packaging (Rs. 800/kg, transport Rs. 200)")
sup = call("POST", "/api/suppliers", {"name": "Akbari Spice Traders", "phone": "0300-1111111", "openingBalance": 0})
pur = call("POST", "/api/purchases", {
    "supplierId": sup["id"], "supplierInvoiceNo": "AK-991", "purchaseDate": today, "transportCost": 200,
    "discountAmount": 0, "taxAmount": 0, "amountPaid": 3000, "paymentMethod": "CASH",
    "lines": [
        {"lineType": "SPICE", "productId": bp["id"], "batchNo": "BP-T1", "quantity": 10000, "rate": 800},
        {"lineType": "MATERIAL", "materialId": pouch50["id"], "quantity": 300, "rate": 2},
        {"lineType": "MATERIAL", "materialId": label["id"], "quantity": 300, "rate": 1},
    ]})
detail = call("GET", f"/api/purchases/{pur['id']}")
check(float(detail["purchase"]["total"]) == 9100, "purchase total = 8000 + 600 + 300 + 200 transport = 9100")
batches = call("GET", f"/api/purchases/batches?productId={bp['id']}")
batch = next(b for b in batches if b["batchNo"] == "BP-T1")
check(batch["grams"] == 10000, "bulk stock 10,000 g in batch BP-T1")
sup_list = call("GET", "/api/suppliers")
check(float(next(s for s in sup_list if s["id"] == sup["id"])["balance"]) == 6100, "supplier payable 9100 - 3000 paid = 6100")

print("3. Packing: plan 200 x 50 g, produce 198 good + 1 rejected, 40 g loss")
po = call("POST", "/api/packing", {"variationId": v50["id"], "batchId": batch["id"], "plannedPackets": 200, "packDate": today})
call("POST", f"/api/packing/{po['id']}/post", {"producedPackets": 198, "rejectedPackets": 1, "lossGrams": 40,
                                               "pouchesUsed": 199, "labelsUsed": 199, "labourCost": 0, "overheadCost": 0}, expect=200)
batches = call("GET", f"/api/purchases/batches?productId={bp['id']}&openOnly=false")
batch = next(b for b in batches if b["batchNo"] == "BP-T1")
check(batch["grams"] == 10000 - 199 * 50 - 40, f"bulk left = 10000 - 9950 - 40 = 10 g (got {batch['grams']})")
stock = call("GET", "/api/inventory/stock")
fin = next(f for f in stock["finished"] if f["variationId"] == v50["id"])
check(fin["packets"] == 198, "finished stock 198 packets of 50 g")
check(fin["damaged"] == 1, "1 rejected packet in damaged stock")
# spice cost per gram = (8000 + landed transport share) / 10000
check(float(fin["avgCost"]) > 40, f"packet cost includes spice + packaging (Rs. {float(fin['avgCost']):.2f})")
call("POST", "/api/packing", {"variationId": v50["id"], "batchId": batch["id"], "plannedPackets": 5, "packDate": today}, expect=400)
check(True, "packing more than available bulk is rejected")

print("4. Customer, invoice with partial payment, balance from ledger")
cust = call("POST", "/api/customers", {"id": str(uuid.uuid4()), "shopName": "Madina General Store", "phone": "0321-2222222",
                                       "area": "Township", "customerType": "RETAILER", "creditLimit": 50000,
                                       "paymentTermsDays": 15, "openingBalance": 1000})
cid = cust["id"]
inv_id = str(uuid.uuid4())
inv_payload = {"id": inv_id, "invoiceNo": f"INV-{prefix}-00001", "invoiceDate": now, "customerId": cid, "paymentMethod": "CASH",
               "amountPaid": 1500, "requiresDelivery": True,
               "lines": [{"id": str(uuid.uuid4()), "variationId": v50["id"], "quantity": 40, "unitPrice": 50, "discountAmount": 0}]}
inv = call("POST", "/api/sales-invoices", inv_payload)
check(inv["status"] == "applied" and float(inv["data"]["total"]) == 2000, "invoice total 40 x Rs. 50 = 2000")
check(float(inv["data"]["previousBalance"]) == 1000 and float(inv["data"]["balanceAfter"]) == 1500,
      "opening 1000 + invoice 2000 - paid 1500 = 1500")
again = call("POST", "/api/sales-invoices", inv_payload)
check(again["status"] == "duplicate", "re-posting the same invoice id is a duplicate, not a second sale")
stock = call("GET", "/api/inventory/stock")
check(next(f for f in stock["finished"] if f["variationId"] == v50["id"])["packets"] == 158, "stock reduced once: 198 - 40 = 158")
custs = call("GET", "/api/customers?q=Madina")["items"]
check(float(custs[0]["balance"]) == 1500, "customer balance 1500 from posted ledger")

print("5. Sales return: 5 good + 2 damaged packets")
full = call("GET", f"/api/sales-invoices/{inv_id}")
line_id = full["invoice"]["lines"][0]["id"]
ret = call("POST", "/api/sales-returns", {"id": str(uuid.uuid4()), "invoiceId": inv_id, "returnDate": now, "settlement": "CREDIT",
                                          "reason": "Torn pouches", "lines": [
                                              {"invoiceLineId": line_id, "quantity": 5, "condition": "GOOD"},
                                              {"invoiceLineId": line_id, "quantity": 2, "condition": "DAMAGED"}]})
check(float(ret["data"]["total"]) == 350, "return credit 7 x 50 = 350")
stock = call("GET", "/api/inventory/stock")
f50 = next(f for f in stock["finished"] if f["variationId"] == v50["id"])
check(f50["packets"] == 163 and f50["damaged"] == 3, "only GOOD packets restocked (163), damaged bucket 1 + 2 = 3")
custs = call("GET", "/api/customers?q=Madina")["items"]
check(float(custs[0]["balance"]) == 1150, "balance 1500 - 350 = 1150")
call("POST", "/api/sales-returns", {"id": str(uuid.uuid4()), "invoiceId": inv_id, "returnDate": now, "settlement": "CREDIT",
                                    "lines": [{"invoiceLineId": line_id, "quantity": 34, "condition": "GOOD"}]}, expect=400)
check(True, "cannot return more than was sold")

print("6. Offline sync: push invoice + receipt, retry the same batch, oversell flagged")
op_inv, op_rc = str(uuid.uuid4()), str(uuid.uuid4())
off_inv = str(uuid.uuid4())
ops = [
    {"opId": op_inv, "type": "invoice.create", "createdAt": now, "payload": {
        "id": off_inv, "invoiceNo": f"INV-{prefix}-00002", "invoiceDate": now, "customerId": cid, "paymentMethod": "CREDIT",
        "amountPaid": 0, "requiresDelivery": False,
        "lines": [{"id": str(uuid.uuid4()), "variationId": v20["id"], "quantity": 3, "unitPrice": 20, "discountAmount": 0}]}},
    {"opId": op_rc, "type": "receipt.create", "createdAt": now, "payload": {
        "id": str(uuid.uuid4()), "receiptNo": f"RC-{prefix}-00001", "customerId": cid, "receiptDate": now,
        "amount": 500, "method": "CASH"}},
]
r1 = call("POST", "/api/sync/push", {"deviceId": DEVICE, "operations": ops})["results"]
check([r["status"] for r in r1] == ["applied", "applied"], "both offline operations applied")
check(any("server stock was 0" in w for w in r1[0]["warnings"]), "oversell of 20 g packets (no stock) flagged, sale kept")
r2 = call("POST", "/api/sync/push", {"deviceId": DEVICE, "operations": ops})["results"]
check(all(r["duplicate"] for r in r2), "retried batch returns stored results (no duplicates)")
custs = call("GET", "/api/customers?q=Madina")["items"]
check(float(custs[0]["balance"]) == 1150 + 60 - 500, "balance = 1150 + 60 - 500 = 710 (counted once)")
conf = call("GET", "/api/sync/conflicts")
check(any(c["conflictType"] == "OVERSELL" for c in conf), "conflict visible for owner review")
bad = call("POST", "/api/sync/push", {"deviceId": DEVICE, "operations": [{"opId": str(uuid.uuid4()), "type": "invoice.create", "createdAt": now,
          "payload": {"id": str(uuid.uuid4()), "invoiceNo": "INV-D99-00001", "invoiceDate": now, "customerId": cid,
                      "paymentMethod": "CASH", "amountPaid": 0, "requiresDelivery": False,
                      "lines": [{"id": str(uuid.uuid4()), "variationId": v50["id"], "quantity": 1, "unitPrice": 50, "discountAmount": 0}]}}]})["results"]
check(bad[0]["status"] == "rejected", "invoice number from another device's range rejected")
pull = call("GET", f"/api/sync/pull?deviceId={DEVICE}")
check(any(s["variationId"] == v50["id"] and s["packets"] == 163 for s in pull["stock"]["finished"]), "pull returns authoritative stock")

print("7. Delivery: load invoice, partial delivery with collection, reconciliation")
route = call("POST", "/api/routes", {"name": "Route A - Township", "area": "Township"})
me = call("GET", "/api/auth/me")
dlv = call("POST", "/api/deliveries", {"routeId": route["id"], "deliveryDate": today, "assignedUserId": me["id"],
                                       "vehicle": "LEB-1234", "invoiceIds": [inv_id], "visitCustomerIds": []})
sheet = call("GET", f"/api/deliveries/{dlv['id']}")
stop = sheet["stops"][0]
check(stop["lines"][0]["loadedQty"] == 33, "loaded quantity = 40 sold - 7 returned = 33")
call("POST", f"/api/deliveries/{dlv['id']}/start", expect=204)
call("POST", "/api/deliveries/stops", {"stopId": stop["id"], "status": "PARTIAL", "lines": [{"lineId": stop["lines"][0]["id"], "deliveredQty": 30}],
                                       "collectedAmount": 200, "collectionMethod": "CASH", "acknowledgedBy": "Shop owner"})
call("POST", "/api/deliveries/stops", {"stopId": stop["id"], "status": "DELIVERED", "collectedAmount": 0}, expect=409)
check(True, "a stop cannot be updated twice")
rec = call("GET", f"/api/deliveries/{dlv['id']}/reconciliation")
g = rec["goods"][0]
check(g["loaded"] == 33 and g["delivered"] == 30 and g["returned"] == 3 and g["pending"] == 0, "loaded 33 = delivered 30 + returned 3")
check(float(rec["money"]["collected"]) == 200, "collection 200 recorded")
stock = call("GET", "/api/inventory/stock")
check(next(f for f in stock["finished"] if f["variationId"] == v50["id"])["packets"] == 166, "3 undelivered packets back in stock (163 + 3)")
call("POST", f"/api/deliveries/{dlv['id']}/complete", expect=204)

print("8. Expenses, cancellation by reversal, reports")
call("POST", "/api/expenses", {"id": str(uuid.uuid4()), "expenseDate": now, "category": "FUEL", "amount": 300, "deliveryId": dlv["id"], "notes": "Route A fuel"})
call("POST", f"/api/purchases/{pur['id']}/cancel", {"reason": "test"}, expect=400)
check(True, "purchase cannot be cancelled after its stock was used")
dash = call("GET", f"/api/reports/dashboard?from={today}&to={today}")
p = dash["profit"]
check(float(p["salesTotal"]) == 2060, "dashboard sales = 2000 + 60")
check(float(p["netSales"]) == 2060 - 350 - 150, "net sales = 2060 - 350 return - 150 delivery return = 1560")
check(float(p["netProfit"]) == round(float(p["grossProfit"]) - 300 - float(p["stockLosses"]), 2), "net profit = gross - expenses - stock losses")
cashbook = call("GET", f"/api/reports/cash-book?from={today}&to={today}")
cash_acc = next(a for a in cashbook["accounts"] if a["kind"] == "CASH")
check(float(cash_acc["closing"]) == -3000 + 1500 + 500 + 200 - 300, "cash = -3000 paid supplier +1500 +500 +200 collected -300 fuel = -1100")
stmt = call("GET", f"/api/reports/customer-statement/{cid}?from={today}&to={today}")
check(float(stmt["closing"]) == 1150 + 60 - 500 - 150 - 200, f"customer statement closing = 360 (got {stmt['closing']})")
aging = call("GET", "/api/reports/aging")
check(float(next(a for a in aging if a["customerId"] == cid)["ledgerBalance"]) == 360, "aging matches ledger")
call("POST", f"/api/sales-invoices/{off_inv}/cancel", {"reason": "Entered by mistake"}, expect=204)
custs = call("GET", "/api/customers?q=Madina")["items"]
check(float(custs[0]["balance"]) == 300, "cancelled invoice reversed in ledger (360 - 60 = 300)")
audit = call("GET", "/api/audit-logs?pageSize=100")
check(audit["total"] > 10, "audit log records every posting")

print(f"\nALL {passed} CHECKS PASSED")
