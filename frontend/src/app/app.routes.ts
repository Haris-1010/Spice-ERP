import { inject } from '@angular/core';
import { CanActivateFn, Routes } from '@angular/router';
import { Auth } from './core/auth';

/** Front-end permission check (the server enforces the same permissions on every request). */
const need = (perm: string): CanActivateFn => () => inject(Auth).can(perm) || inject(Auth).user() === null;

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'dashboard' },
  { path: 'dashboard', loadComponent: () => import('./pages/dashboard').then(m => m.DashboardPage) },
  { path: 'products', canActivate: [need('products.view')], loadComponent: () => import('./pages/products').then(m => m.ProductsPage) },
  { path: 'purchases', canActivate: [need('purchases.view')], loadComponent: () => import('./pages/purchases').then(m => m.PurchasesPage) },
  { path: 'bulk', canActivate: [need('inventory.view')], loadComponent: () => import('./pages/inventory').then(m => m.BulkPage) },
  { path: 'stock', canActivate: [need('inventory.view')], loadComponent: () => import('./pages/inventory').then(m => m.FinishedPage) },
  { path: 'packing', canActivate: [need('packing.post')], loadComponent: () => import('./pages/packing').then(m => m.PackingPage) },
  { path: 'customers', canActivate: [need('customers.view')], loadComponent: () => import('./pages/customers').then(m => m.CustomersPage) },
  { path: 'suppliers', canActivate: [need('suppliers.view')], loadComponent: () => import('./pages/suppliers').then(m => m.SuppliersPage) },
  { path: 'sales', canActivate: [need('sales.view')], loadComponent: () => import('./pages/sales').then(m => m.SalesPage) },
  { path: 'sales/new', canActivate: [need('sales.create')], loadComponent: () => import('./pages/invoice-new').then(m => m.InvoiceNewPage) },
  { path: 'sales/:id', canActivate: [need('sales.view')], loadComponent: () => import('./pages/invoice-view').then(m => m.InvoiceViewPage) },
  { path: 'deliveries', canActivate: [need('delivery.execute')], loadComponent: () => import('./pages/deliveries').then(m => m.DeliveriesPage) },
  { path: 'deliveries/:id', canActivate: [need('delivery.execute')], loadComponent: () => import('./pages/delivery-run').then(m => m.DeliveryRunPage) },
  { path: 'payments', canActivate: [need('receipts.create')], loadComponent: () => import('./pages/payments').then(m => m.PaymentsPage) },
  { path: 'expenses', canActivate: [need('expenses.create')], loadComponent: () => import('./pages/expenses').then(m => m.ExpensesPage) },
  { path: 'reports', canActivate: [need('reports.view')], loadComponent: () => import('./pages/reports').then(m => m.ReportsPage) },
  { path: 'users', canActivate: [need('users.manage')], loadComponent: () => import('./pages/users').then(m => m.UsersPage) },
  { path: 'sync', loadComponent: () => import('./pages/sync').then(m => m.SyncPage) },
  { path: 'settings', loadComponent: () => import('./pages/settings').then(m => m.SettingsPage) },
  { path: '**', redirectTo: 'dashboard' },
];
