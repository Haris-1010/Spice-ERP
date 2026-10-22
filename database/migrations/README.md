# Schema migrations

`schema.sql` is version 1 and is applied automatically to an empty database.

For every later change add a file named `NNN_description.sql` (e.g. `002_add_customer_email.sql`).
On start-up the API applies, in order and each in its own transaction, every script whose number is
greater than `ApplicationSettings.SchemaVersion`, then records the new version.

Rules: never edit a script that has been applied; ledger tables are append-only — add columns, never rewrite history.
Mirror every change in `backend/SpiceErp.Api/Data/Entities.cs` so EF Core maps it.
