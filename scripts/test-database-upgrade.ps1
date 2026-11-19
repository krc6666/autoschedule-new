param([Parameter(Mandatory)][int]$Port, [Parameter(Mandatory)][string]$FixtureDirectory)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'upgrade-database.ps1')

function Assert-Outcome($condition, [string]$label) {
    if (!$condition) { throw "Failed: $label" }
    Write-Host "Passed: $label"
}

function Assert-Rejected([string]$message) {
    try { Invoke-DatabaseUpgrade | Out-Null } catch {
        if ($_.Exception.Message -like $message) { return }
        throw
    }
    throw "Expected failure matching $message"
}

Get-ChildItem Env:PG* | ForEach-Object { Remove-Item -LiteralPath ('Env:' + $_.Name) }
$env:PGHOST = '127.0.0.1'
$env:PGPORT = [string]$Port
$env:PGUSER = 'postgres'
$env:PGDATABASE = 'postgres'
$env:PGSSLMODE = 'disable'
$env:PGCLIENTENCODING = 'UTF8'
$fixture = (Resolve-Path -LiteralPath $FixtureDirectory).ProviderPath
$tempRoot = (Resolve-Path -LiteralPath ([IO.Path]::GetTempPath())).ProviderPath.TrimEnd('\') + '\'
if (!$fixture.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -or (Invoke-UpgradeSql 'show data_directory;').Replace('/', '\') -cne (Join-Path $fixture 'data')) { throw 'Expected an isolated local PostgreSQL cluster.' }
$migrationSource = Join-Path $root 'supabase/migrations'
$stateDir = Join-Path $fixture ('scenario-' + [guid]::NewGuid().ToString('N'))
$root = Join-Path $stateDir 'checkout'
$migrationFolder = Join-Path $root 'supabase/migrations'
[void][IO.Directory]::CreateDirectory($migrationFolder)
Get-ChildItem -LiteralPath $migrationSource -File | Where-Object Name -le '202611180001_z.sql' | Copy-Item -Destination $migrationFolder
$fixtureName = 'upgrade_' + [guid]::NewGuid().ToString('N')
Invoke-UpgradeSql "create database $fixtureName;"
$env:PGDATABASE = $fixtureName
$authFixture = 'create schema auth; create table auth.users(id uuid primary key, email text); create function auth.uid() returns uuid language sql stable as $$select null::uuid$$;'
Invoke-UpgradeSql $authFixture
foreach ($migration in (Get-ChildItem -LiteralPath $migrationFolder -File | Sort-Object Name)) {
    Invoke-PgTool 'psql' @('-X', '-q', '-v', 'ON_ERROR_STOP=1', '-f', $migration.FullName)
}
Invoke-UpgradeSql "insert into public.autoschedule_workspace(version, model) values (42, '{`"fixture`":true}');"

Invoke-UpgradeSql 'alter table public.autoschedule_workspace disable row level security;'
Assert-Rejected '*does not match the known*'
Assert-Outcome (!(Test-Path -LiteralPath (Join-Path $stateDir 'backups')) -and @(Get-UpgradeHistory).Count -eq 0) 'schema mismatch stops before backup and registration'
Invoke-UpgradeSql 'alter table public.autoschedule_workspace enable row level security;'

$version = Join-Path $migrationFolder '202611190099_fixture.sql'
$body = 'create table public.autoschedule_upgrade_fixture(id integer);'
[IO.File]::WriteAllText($version, "begin;`n$body select 1/0;`ncommit;`n", $utf8)
Assert-Rejected '*psql exited*'
Assert-Outcome ((Invoke-UpgradeSql "select to_regclass('public.autoschedule_upgrade_fixture') is null;") -eq 't' -and @(Get-UpgradeHistory).Count -eq 0) 'failed migration rolls back schema and history'

[IO.File]::WriteAllText($version, "begin;`n$body`ncommit;`n", $utf8)
$result = Invoke-DatabaseUpgrade
Assert-Outcome ($result.Adopted -eq 5 -and $result.Applied -eq 1 -and @(Get-UpgradeHistory).Count -eq 6) 'registers five existing migrations and applies only the new one'
Assert-Outcome ((Get-FileHash -LiteralPath $result.Backup -Algorithm SHA256).Hash -eq (Get-Content -LiteralPath ($result.Backup + '.sha256'))) 'saved backup matches its checksum'
$retry = Invoke-DatabaseUpgrade
Assert-Outcome (!$retry.Applied -and !$retry.Adopted -and !$retry.Backup) 'repeated launch is a no-op'

Invoke-UpgradeSql "insert into $historyTable(version) values ('209901010001');"
Assert-Rejected '*history does not match*'
Assert-Outcome ((Invoke-UpgradeSql 'select version from public.autoschedule_workspace;') -eq '42') 'unknown history stops and workspace data remains'

$restoreName = $fixtureName + '_restore'
Invoke-UpgradeSql "create database $restoreName;"
$env:PGDATABASE = $restoreName
Invoke-UpgradeSql $authFixture
$restoreList = Join-Path $stateDir 'restore-list.txt'
$entries = @(Invoke-PgTool 'pg_restore' @('--list', $result.Backup) | Where-Object { $_ -notmatch ' SCHEMA - public ' })
[IO.File]::WriteAllLines($restoreList, [string[]]$entries, $utf8)
Invoke-PgTool 'pg_restore' @('-w', '--exit-on-error', '--no-owner', "--dbname=$restoreName", '--use-list', $restoreList, $result.Backup)
Assert-Outcome ((Invoke-UpgradeSql "select version = 42 and model = '{`"fixture`":true}' and to_regclass('public.autoschedule_upgrade_fixture') is null from public.autoschedule_workspace;") -eq 't') 'independent restore recovers original workspace and schema'
