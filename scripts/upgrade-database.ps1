param([switch]$Configure, [switch]$Pause)

$ErrorActionPreference = 'Stop'
$scriptsDir = $PSScriptRoot
$root = Split-Path -Parent $scriptsDir
$stateDir = Join-Path $env:LOCALAPPDATA 'AutoscheduleDatabaseTools'
$bin = Join-Path $stateDir 'pgsql/bin'
$historyTable = 'supabase_migrations.schema_migrations'
$legacyThrough = '202611180001'
$legacySchema = '37945f9f9d53e17fe4cea059e60828a9'
$utf8 = New-Object Text.UTF8Encoding($false)

function Invoke-PgTool($tool, [string[]]$arguments) {
    $executable = Join-Path $bin "$tool.exe"
    $output = & $executable @arguments
    if ($LASTEXITCODE -ne 0) { throw "$tool exited with code $LASTEXITCODE" }
    $output
}

function Invoke-UpgradeSql([string]$sql, [switch]$Transaction) {
    $tempSql = Join-Path $stateDir ('query-' + [guid]::NewGuid().ToString('N') + '.sql')
    try {
        [IO.File]::WriteAllText($tempSql, $sql, $utf8)
        $arguments = @('-X', '-w', '-qAt', '-v', 'ON_ERROR_STOP=1', '-f', $tempSql)
        if ($Transaction) { $arguments = @('--single-transaction') + $arguments }
        Invoke-PgTool 'psql' $arguments
    } finally {
        if (Test-Path -LiteralPath $tempSql) { Remove-Item -LiteralPath $tempSql }
    }
}

function Get-UpgradeHistory {
    if ((Invoke-UpgradeSql "select to_regclass('$historyTable') is not null;") -eq 't') {
        Invoke-UpgradeSql "select version from $historyTable order by version;"
    }
}

function Get-UpgradeSchema {
    Invoke-UpgradeSql ("set search_path = pg_catalog;`n" + [IO.File]::ReadAllText((Join-Path $scriptsDir 'database-schema-check.sql')))
}

function Get-UpgradeMigrations {
    foreach ($migration in (Get-ChildItem -LiteralPath (Join-Path $root 'supabase/migrations') -File | Sort-Object Name)) {
        if ($migration.Name -notmatch '^(?<version>\d{12,14})_(?<name>[a-z0-9_]+)\.sql$') { throw 'Invalid migration filename.' }
        $version = $Matches.version
        $name = $Matches.name
        $sql = [IO.File]::ReadAllText($migration.FullName)
        $outer = [regex]::Match($sql, '(?ims)\A(?:\s|--[^\r\n]*\r?\n)*begin;\s*(?<body>.*?)\s*commit;\s*\z')
        if (!$outer.Success) { throw "Migration must have one BEGIN/COMMIT wrapper: $($migration.Name)" }
        $body = $outer.Groups['body'].Value
        $literals = @'
(?<tag>\$(?:[a-zA-Z_][a-zA-Z_0-9]*)?\$)[\s\S]*?\k<tag>|'(?:''|[^'])*'|"(?:""|[^"])*"|--[^\r\n]*|/\*[\s\S]*?\*/
'@
        $topLevel = [regex]::Replace($body, $literals, ' ')
        if ($topLevel -match '(?i)\\|(?:^|;)\s*(?:begin|start\s+transaction|commit|end|rollback|abort|prepare\s+transaction|copy)\b') {
            throw "Unsupported transaction or psql command: $($migration.Name)"
        }
        [pscustomobject]@{ Version = $version; Name = $name; Body = $body }
    }
}

function New-UpgradeBackup {
    $tables = @(Invoke-UpgradeSql "select relname from pg_class where relnamespace = 'public'::regnamespace and relkind in ('r', 'p') and (relname like 'autoschedule\_%' or relname = 'schedule_versions');")
    if ($tables -notcontains 'autoschedule_workspace') { throw 'Workspace table is missing.' }
    $backupFolder = Join-Path $stateDir 'backups'
    [void][IO.Directory]::CreateDirectory($backupFolder)
    $backup = Join-Path $backupFolder ((Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8) + '.dump')
    $partial = "$backup.partial"
    try {
        Invoke-PgTool 'pg_dump' @('-w', '--format=custom', '--schema=public', '--lock-wait-timeout=10s', '--file', $partial) | Out-Null
        $archive = Invoke-PgTool 'pg_restore' @('--list', $partial)
        foreach ($table in $tables) {
            if (!($archive -cmatch (' TABLE DATA public ' + [regex]::Escape($table) + ' '))) { throw "Table is missing from the backup: $table" }
        }
        Invoke-PgTool 'pg_restore' @('--file=NUL', $partial) | Out-Null
        Move-Item -LiteralPath $partial -Destination $backup
        (Get-FileHash -LiteralPath $backup -Algorithm SHA256).Hash | Set-Content -LiteralPath "$backup.sha256" -Encoding ascii
        $backup
    } finally {
        if (Test-Path -LiteralPath $partial) { Remove-Item -LiteralPath $partial }
    }
}

function Invoke-DatabaseUpgrade {
    $migrations = @(Get-UpgradeMigrations)
    $versions = @($migrations.Version)
    if (!$versions.Count -or ($versions | Select-Object -Unique).Count -ne $versions.Count) { throw 'Migration versions must be unique.' }
    $installed = @(Get-UpgradeHistory)
    if ($installed.Count -gt $versions.Count -or ($installed.Count -and (($installed -join ',') -cne ($versions[0..($installed.Count - 1)] -join ',')))) {
        throw 'The database migration history does not match this checkout.'
    }
    $baseline = @($migrations | Select-Object -Skip $installed.Count | Where-Object { $_.Version -le $legacyThrough })
    if ($baseline.Count -and ((Get-UpgradeSchema) -cne $legacySchema -or $baseline[-1].Version -ne $legacyThrough)) {
        throw 'The database structure does not match the known manually installed version.'
    }
    $pending = @($migrations | Select-Object -Skip ($installed.Count + $baseline.Count))
    if (!$pending.Count -and !$baseline.Count) { return [pscustomobject]@{ Applied = 0; Adopted = 0 } }

    if ($pending.Count) { Write-Host ('待安装版本 ' + ($pending.Version -join '、')) }
    Write-Host '正在备份并核对数据库…'
    $backup = New-UpgradeBackup
    Write-Host ('已保存备份 ' + $backup)
    $statements = @(
        "set local lock_timeout = '10s';",
        'select pg_advisory_xact_lock(214722445, 218117301);',
        'create schema if not exists supabase_migrations;',
        "create table if not exists $historyTable (version text primary key, statements text[], name text);",
        "lock table $historyTable in share row exclusive mode;",
        "alter table $historyTable add column if not exists name text;",
        "select coalesce(string_agg(version, ',' order by version), '') = '$($installed -join ',')' as history_ok from $historyTable \gset",
        '\if :history_ok', '\else', 'select 1/0;', '\endif'
    )
    if ($baseline.Count) {
        $signatureQuery = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'database-schema-check.sql')).Trim().TrimEnd(';')
        $statements += @('set local search_path = pg_catalog;',
            "select ($signatureQuery) = '$legacySchema' as baseline_ok \gset", 'reset search_path;',
            '\if :baseline_ok', '\else', 'select 1/0;', '\endif')
    }
    foreach ($migration in $baseline) {
        $statements += "insert into $historyTable (version, name) values ('$($migration.Version)', '$($migration.Name)');"
    }
    foreach ($migration in $pending) {
        $statements += $migration.Body
        $originalSql = $migration.Body.Replace("'", "''")
        $statements += "insert into $historyTable (version, name, statements) values ('$($migration.Version)', '$($migration.Name)', array['$originalSql']);"
    }
    Write-Host '正在安装和核对版本…'
    Invoke-UpgradeSql ($statements -join "`n") -Transaction | Out-Null
    if ((@(Get-UpgradeHistory) -join ',') -cne ($versions -join ',')) { throw 'Post-installation version verification failed.' }
    [pscustomobject]@{ Applied = $pending.Count; Adopted = $baseline.Count; Backup = $backup }
}

function Get-UpgradeProject {
    $envFile = Join-Path $root '.env.local'
    $line = Get-Content -LiteralPath $envFile -Encoding UTF8 | Where-Object { $_ -match '^\s*VITE_SUPABASE_URL\s*=' } | Select-Object -Last 1
    if ($line -notmatch 'https://([a-z0-9]{20})\.supabase\.co/?["'']?\s*$') { throw 'The project Supabase URL was not found or is not supported.' }
    $Matches[1]
}

function Set-UpgradeConnection($connection, [string]$project) {
    $pooler = $connection.Host -match '^aws-[0-9]+-[a-z0-9-]+\.pooler\.supabase\.com$' -and $connection.User -ceq "postgres.$project"
    $direct = $connection.Host -ceq "db.$project.supabase.co" -and $connection.User -ceq 'postgres'
    if (!$pooler -and !$direct) { throw 'Connection does not match this Supabase project or is not a session connection.' }
    Get-ChildItem Env:PG* | ForEach-Object { Remove-Item -LiteralPath ('Env:' + $_.Name) }
    $env:PGHOST = $connection.Host
    $env:PGUSER = $connection.User
    $env:PGPORT = '5432'
    $env:PGDATABASE = 'postgres'
    $env:PGSSLMODE = 'verify-full'
    $certificate = Join-Path $stateDir "$project-ca.crt"
    if (!(Test-Path -LiteralPath $certificate -PathType Leaf)) {
        $certificate = Join-Path $stateDir 'windows-trusted-roots.pem'
        $roots = @(Get-ChildItem 'Cert:/LocalMachine/Root', 'Cert:/CurrentUser/Root' | Sort-Object Thumbprint -Unique)
        $pem = foreach ($trustedRoot in $roots) {
            '-----BEGIN CERTIFICATE-----'
            [Convert]::ToBase64String($trustedRoot.RawData, [Base64FormattingOptions]::InsertLineBreaks)
            '-----END CERTIFICATE-----'
        }
        if (!$pem) { throw '电脑没有可用于验证数据库连接的根证书。' }
        [IO.File]::WriteAllLines($certificate, [string[]]$pem, $utf8)
    }
    $env:PGSSLROOTCERT = $certificate
    $env:PGCONNECT_TIMEOUT = '12'
    $env:PGCLIENTENCODING = 'UTF8'
    $env:PGPASSWORD = [Net.NetworkCredential]::new('', $connection.Password).Password
}

function Start-DesktopUpgrade {
    foreach ($tool in 'psql.exe', 'pg_dump.exe', 'pg_restore.exe') {
        if (!(Test-Path -LiteralPath (Join-Path $bin $tool) -PathType Leaf)) { throw '电脑缺少 PostgreSQL 工具。请先安装客户端组件。' }
    }
    $project = Get-UpgradeProject
    $configPath = Join-Path $stateDir "$project.connection.xml"
    $newConfig = $Configure -or !(Test-Path -LiteralPath $configPath)
    if ($newConfig) {
        Write-Host '首次设置。请在 Supabase 的 Connect 选择 Session pooler。'
        $uriText = Read-Host '粘贴连接地址（保留 [YOUR-PASSWORD] 占位）'
        if ($uriText -notmatch '^postgres(?:ql)?://([^:@/]+):\[YOUR-PASSWORD\]@([a-z0-9.-]+):5432/postgres/?$') { throw '请复制带 [YOUR-PASSWORD] 的 Session pooler 连接地址。' }
        $connection = [pscustomobject]@{ User = $Matches[1]; Host = $Matches[2]; Password = (Read-Host '输入数据库密码' -AsSecureString) }
    } else {
        $connection = Import-Clixml -LiteralPath $configPath
    }
    try {
        Set-UpgradeConnection $connection $project
        if ((Invoke-UpgradeSql 'select 1;') -ne '1') { throw '无法核对数据库连接。' }
        if ($newConfig) { $connection | Export-Clixml -LiteralPath $configPath }
        $result = Invoke-DatabaseUpgrade
        Write-Host ('完成。安装新更新 {0} 项，登记旧更新 {1} 项。' -f $result.Applied, $result.Adopted)
    } finally {
        Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
    }
}

if ($MyInvocation.InvocationName -ne '.') {
    try {
        Start-DesktopUpgrade
    } catch {
        Write-Host ('升级已停止。' + $_.Exception.Message) -ForegroundColor Red
        exit 1
    } finally {
        if ($Pause) { [void](Read-Host '按回车关闭窗口') }
    }
}
