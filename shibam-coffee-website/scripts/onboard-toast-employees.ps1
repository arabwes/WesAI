param(
  [switch]$Apply,
  [string]$CafeMcpSecretFile = 'C:\secure\cafe-mcp-production.env'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$toastConfig = Join-Path $projectRoot 'workers\toast-mcp\wrangler.jsonc'
$excludedNames = @('Support Appfront', 'Shibam Coffee')

function Invoke-D1Json {
  param(
    [Parameter(Mandatory)][string]$Database,
    [Parameter(Mandatory)][string]$Sql,
    [string]$Config
  )

  # Wrangler's Windows command shim can split multiline --command values. D1 SQL
  # generated here contains no meaningful whitespace inside string literals, so
  # collapse it to one line before passing it across the process boundary.
  $Sql = ($Sql -replace '\s+', ' ').Trim()
  $arguments = @('wrangler', 'd1', 'execute', $Database, '--remote', '--json', '--command', $Sql)
  if ($Config) { $arguments += @('--config', $Config) }
  $output = & npx @arguments 2>$null
  if ($LASTEXITCODE -ne 0) { throw "Unable to query D1 database $Database." }
  return ($output | ConvertFrom-Json)[0].results
}

function Read-EnvFile {
  param([Parameter(Mandatory)][string]$Path)

  if (-not (Test-Path -LiteralPath $Path)) { throw "Secret file not found: $Path" }
  $values = @{}
  foreach ($line in Get-Content -LiteralPath $Path) {
    if ($line -match '^\s*([A-Za-z][A-Za-z0-9_]*)=(.*)$') {
      $values[$matches[1]] = $matches[2].Trim()
    }
  }
  return $values
}

function Unprotect-ToastSecret {
  param(
    [Parameter(Mandatory)]$Connection,
    [Parameter(Mandatory)][string]$Base64Key
  )

  $key = [Convert]::FromBase64String($Base64Key)
  $nonce = [Convert]::FromBase64String([string]$Connection.secret_nonce)
  $combined = [Convert]::FromBase64String([string]$Connection.encrypted_client_secret)
  $ciphertext = [byte[]]::new($combined.Length - 16)
  $tag = [byte[]]::new(16)
  [Array]::Copy($combined, 0, $ciphertext, 0, $ciphertext.Length)
  [Array]::Copy($combined, $ciphertext.Length, $tag, 0, 16)
  $plaintext = [byte[]]::new($ciphertext.Length)
  $associatedData = [Text.Encoding]::UTF8.GetBytes(
    "toast-connection:$($Connection.organization_id):$($Connection.connection_id)"
  )
  $aes = [Security.Cryptography.AesGcm]::new($key, 16)
  try {
    $aes.Decrypt($nonce, $ciphertext, $tag, $plaintext, $associatedData)
    return [Text.Encoding]::UTF8.GetString($plaintext)
  } finally {
    $aes.Dispose()
  }
}

function ConvertTo-PortalUsername {
  param(
    [Parameter(Mandatory)][string]$FirstName,
    [Parameter(Mandatory)][string]$LastName
  )

  $candidate = ($FirstName.Substring(0, 1) + $LastName).Normalize([Text.NormalizationForm]::FormD)
  return ($candidate -replace '[^A-Za-z0-9]', '').ToLowerInvariant()
}

function Get-PortalRole {
  param([string[]]$JobTitles)

  $jobs = $JobTitles -join ' '
  if ($jobs -match '(?i)shift manager|assistant manager|lead|supervisor') { return 'lead' }
  if ($jobs -match '(?i)general manager|owner|\bgm\b') { return 'management' }
  return 'barista'
}

function New-PasswordRecord {
  param([Parameter(Mandatory)][string]$Password)

  $saltBytes = [byte[]]::new(16)
  [Security.Cryptography.RandomNumberGenerator]::Fill($saltBytes)
  $salt = [Convert]::ToHexString($saltBytes).ToLowerInvariant()
  $derive = [Security.Cryptography.Rfc2898DeriveBytes]::new(
    $Password,
    [Text.Encoding]::UTF8.GetBytes($salt),
    100000,
    [Security.Cryptography.HashAlgorithmName]::SHA256
  )
  try {
    return @{
      Salt = $salt
      Hash = [Convert]::ToHexString($derive.GetBytes(32)).ToLowerInvariant()
    }
  } finally {
    $derive.Dispose()
  }
}

function ConvertTo-SqlLiteral {
  param([AllowNull()][string]$Value)
  if ($null -eq $Value) { return 'NULL' }
  return "'" + ($Value -replace "'", "''") + "'"
}

Push-Location $projectRoot
try {
  $connection = Invoke-D1Json -Database 'cafe-mcp-db' -Config $toastConfig -Sql @'
SELECT c.id AS connection_id,
       c.organization_id,
       c.client_id,
       c.encrypted_client_secret,
       c.secret_nonce,
       l.toast_guid
  FROM toast_connections c
  JOIN toast_locations l ON l.connection_id = c.id
 WHERE c.status = 'active' AND l.status = 'active'
 LIMIT 1;
'@ | Select-Object -First 1
  if (-not $connection) { throw 'No active Toast API connection and location were found.' }

  $secrets = Read-EnvFile -Path $CafeMcpSecretFile
  if (-not $secrets.ContainsKey('CREDENTIAL_KEK_V1')) {
    throw 'CREDENTIAL_KEK_V1 is missing from the Cafe MCP production secret file.'
  }
  $toastClientSecret = Unprotect-ToastSecret -Connection $connection -Base64Key $secrets.CREDENTIAL_KEK_V1
  $authBody = @{
    clientId = $connection.client_id
    clientSecret = $toastClientSecret
    userAccessType = 'TOAST_MACHINE_CLIENT'
  } | ConvertTo-Json -Compress
  $auth = Invoke-RestMethod -Method Post `
    -Uri 'https://ws-api.toasttab.com/authentication/v1/authentication/login' `
    -ContentType 'application/json' `
    -Body $authBody
  if (-not $auth.token.accessToken) { throw 'Toast authentication did not return an access token.' }

  $headers = @{
    Authorization = "Bearer $($auth.token.accessToken)"
    'Toast-Restaurant-External-ID' = $connection.toast_guid
  }
  [object[]]$employees = Invoke-RestMethod -Method Get `
    -Uri 'https://ws-api.toasttab.com/labor/v1/employees' -Headers $headers
  [object[]]$jobs = Invoke-RestMethod -Method Get `
    -Uri 'https://ws-api.toasttab.com/labor/v1/jobs' -Headers $headers

  $jobsByGuid = @{}
  foreach ($job in $jobs) { $jobsByGuid[[string]$job.guid] = [string]$job.title }

  $existingUsers = @(Invoke-D1Json -Database 'shibam-team' -Sql 'SELECT id, username, email FROM users;')
  $admin = $existingUsers | Where-Object { $_.username -eq 'admin' } | Select-Object -First 1
  if (-not $admin) { throw 'The production admin account was not found.' }

  $candidates = @()
  $skipped = @()
  foreach ($employee in $employees) {
    if ($employee.deleted -eq $true) { continue }
    $firstName = ([string]$employee.firstName).Trim()
    $lastName = ([string]$employee.lastName).Trim()
    if (-not $firstName -or -not $lastName) { continue }
    $name = "$firstName $lastName"
    if ($name -in $excludedNames) {
      $skipped += [pscustomobject]@{ Name = $name; Reason = 'service account' }
      continue
    }

    $username = ConvertTo-PortalUsername -FirstName $firstName -LastName $lastName
    $email = ([string]$employee.email).Trim().ToLowerInvariant()
    $existing = $existingUsers | Where-Object {
      ($_.username -and $_.username.ToLowerInvariant() -eq $username) -or
      ($email -and $_.email -and $_.email.ToLowerInvariant() -eq $email)
    } | Select-Object -First 1
    if ($existing) {
      $skipped += [pscustomobject]@{ Name = $name; Reason = "already represented by $($existing.username)" }
      continue
    }

    $jobTitles = @(
      $employee.jobReferences |
        ForEach-Object { $jobsByGuid[[string]$_.guid] } |
        Where-Object { $_ } |
        Sort-Object -Unique
    )
    $role = Get-PortalRole -JobTitles $jobTitles
    $chosenName = ([string]$employee.chosenName).Trim()
    $preferredName = if ($chosenName -and $chosenName -ne $firstName -and $chosenName -ne $name) {
      $chosenName
    } else { '' }

    $candidates += [pscustomobject]@{
      FirstName = $firstName
      Name = $name
      PreferredName = $preferredName
      Username = $username
      Email = if ($email) { $email } else { $null }
      Role = $role
      PositionId = if ($role -eq 'management') {
        'position-management'
      } elseif ($role -eq 'lead') {
        'position-lead'
      } else {
        'position-barista'
      }
    }
  }

  $duplicateUsernames = @($candidates | Group-Object Username | Where-Object { $_.Count -gt 1 })
  if ($duplicateUsernames.Count) {
    throw "Duplicate generated username(s): $($duplicateUsernames.Name -join ', ')"
  }

  Write-Host "Toast active employees: $(@($employees | Where-Object { $_.deleted -ne $true }).Count)"
  Write-Host "New portal accounts: $($candidates.Count)"
  $candidates | Select-Object Name, Username, Role, PreferredName | Sort-Object Role, Name | Format-Table -AutoSize
  if ($skipped.Count) {
    Write-Host 'Skipped records:'
    $skipped | Sort-Object Name | Format-Table -AutoSize
  }
  if (-not $Apply) {
    Write-Host 'Dry run only. Re-run with -Apply after reviewing the mapping.'
    return
  }
  if (-not $candidates.Count) {
    Write-Host 'No new accounts need to be created.'
    return
  }

  $timestamp = [DateTime]::UtcNow.ToString('o')
  $statements = [Collections.Generic.List[string]]::new()
  $statements.Add('PRAGMA foreign_keys = ON;')
  foreach ($employee in $candidates) {
    $userId = 'usr_' + [guid]::NewGuid().ToString()
    $password = 'Barista' + $employee.FirstName + '123!'
    $passwordRecord = New-PasswordRecord -Password $password
    $statements.Add(@"
INSERT INTO users
  (id, username, name, email, role, password_hash, password_salt, password_algorithm,
   max_weekly_minutes, active, created_at, updated_at, preferred_name)
VALUES
  ($(ConvertTo-SqlLiteral $userId), $(ConvertTo-SqlLiteral $employee.Username),
   $(ConvertTo-SqlLiteral $employee.Name), $(ConvertTo-SqlLiteral $employee.Email),
   $(ConvertTo-SqlLiteral $employee.Role), $(ConvertTo-SqlLiteral $passwordRecord.Hash),
   $(ConvertTo-SqlLiteral $passwordRecord.Salt), 'pbkdf2-sha256', 2400, 1,
   $(ConvertTo-SqlLiteral $timestamp), $(ConvertTo-SqlLiteral $timestamp),
   $(ConvertTo-SqlLiteral $employee.PreferredName));
"@)
    $statements.Add(
      "INSERT INTO employee_positions (user_id, position_id) VALUES " +
      "($(ConvertTo-SqlLiteral $userId), $(ConvertTo-SqlLiteral $employee.PositionId));"
    )
    $details = @{ username = $employee.Username; role = $employee.Role; source = 'toast' } |
      ConvertTo-Json -Compress
    $auditId = 'audit_' + [guid]::NewGuid().ToString()
    $statements.Add(
      'INSERT INTO audit_events ' +
      '(id, actor_user_id, action, entity_type, entity_id, details_json, created_at) VALUES ' +
      "($(ConvertTo-SqlLiteral $auditId), $(ConvertTo-SqlLiteral $admin.id), 'user.add', 'user', " +
      "$(ConvertTo-SqlLiteral $userId), $(ConvertTo-SqlLiteral $details), $(ConvertTo-SqlLiteral $timestamp));"
    )
  }
  $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
  $tempDirectory = [IO.Path]::GetFullPath((Join-Path $tempRoot ('shibam-onboarding-' + [guid]::NewGuid())))
  if (-not $tempDirectory.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'The generated temporary path is outside the system temporary directory.'
  }
  [IO.Directory]::CreateDirectory($tempDirectory) | Out-Null
  $sqlFile = Join-Path $tempDirectory 'employee-onboarding.sql'
  try {
    [IO.File]::WriteAllText($sqlFile, [string]::Join([Environment]::NewLine, $statements))
    & npx wrangler d1 execute shibam-team --remote --file $sqlFile
    if ($LASTEXITCODE -ne 0) { throw 'The production employee import failed.' }
  } finally {
    $resolvedDirectory = [IO.Path]::GetFullPath($tempDirectory)
    if ($resolvedDirectory.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -and
        (Test-Path -LiteralPath $resolvedDirectory)) {
      Remove-Item -LiteralPath $resolvedDirectory -Recurse -Force
    }
  }

  Write-Host "Created $($candidates.Count) production portal account(s)."
} finally {
  Pop-Location
}
