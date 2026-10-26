<#
C4C self-hosted: post-install check for Windows PowerShell 5.1 or PowerShell 7.

  $env:C4C_AUTH_TOKEN = '<your token>'     # read from the environment, never printed
  .\verify-install.ps1 -Url https://c4c.example.internal/mcp

Checks /healthz, MCP initialize, tools/list and one lookup_citation call.
Exit 0 when every check passes, 1 when any fails.
Research use only. C4C returns regulatory text and citations; it is not legal advice.
#>
param(
  [Parameter(Mandatory = $true)][string]$Url,
  [int]$TimeoutSec = 20
)

$ErrorActionPreference = 'Stop'
# Windows PowerShell 5.1 defaults to old TLS versions.
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}

$base = $Url.TrimEnd('/')
$health = ($base -replace '/mcp$', '') + '/healthz'
$token = $env:C4C_AUTH_TOKEN
if ($token) { $token = $token.Trim() }
$script:failed = $false
$core = @('search_regs','lookup_citation','get_obligation','find_in_section','verify_quote','get_reg','list_playbooks','start_playbook')

function Write-Check([string]$Status, [string]$Name, [string]$Detail) {
  if ($Status -eq 'FAIL') { $script:failed = $true }
  Write-Output ('[{0}] {1,-10} {2}' -f $Status, $Name, $Detail)
}

function Get-HttpStatus($err) {
  $r = $err.Exception.Response
  if ($r -ne $null) { return [int]$r.StatusCode }
  return 0
}

# Returns @{ Status = <int>; Json = <object or $null>; Text = <string> }. Handles JSON or SSE bodies.
function Invoke-Rpc([string]$Body, [bool]$WithToken = $true) {
  $headers = @{ 'Accept' = 'application/json, text/event-stream' }
  if ($WithToken -and $token) { $headers['Authorization'] = "Bearer $token" }
  try {
    $r = Invoke-WebRequest -Uri $base -Method Post -Headers $headers -ContentType 'application/json' `
      -Body ([Text.Encoding]::UTF8.GetBytes($Body)) -UseBasicParsing -TimeoutSec $TimeoutSec
    $status = [int]$r.StatusCode
    $text = $r.Content
    if ($text -is [byte[]]) { $text = [Text.Encoding]::UTF8.GetString($text) }
  } catch {
    $status = Get-HttpStatus $_
    if ($status -eq 0) { throw }
    return @{ Status = $status; Json = $null; Text = '' }
  }
  $jsonText = $text
  $dataLines = @($text -split "`r?`n" | Where-Object { $_ -like 'data:*' })
  if ($dataLines.Count -gt 0) { $jsonText = $dataLines[-1].Substring(5).Trim() }
  $json = $null
  try { $json = $jsonText | ConvertFrom-Json } catch {}
  return @{ Status = $status; Json = $json; Text = $text }
}

if ($token) { Write-Output "C4C install check: $base (token from C4C_AUTH_TOKEN)" } else { Write-Output "C4C install check: $base (token not set)" }
Write-Output ''

# 1. Health
try {
  $h = Invoke-WebRequest -Uri $health -UseBasicParsing -TimeoutSec $TimeoutSec
  $hb = $h.Content | ConvertFrom-Json
  $d = "library $($hb.library_version), $($hb.age_days) days old"
  if ($hb.stale) { Write-Check 'WARN' 'Health' "$d, STALE (check updates)" } else { Write-Check 'PASS' 'Health' "$d, current" }
} catch {
  $s = Get-HttpStatus $_
  if ($s -eq 503) { Write-Check 'FAIL' 'Health' 'server is up but no library is installed yet' }
  elseif ($s -eq 0) { Write-Check 'FAIL' 'Health' "cannot reach ${health}: $($_.Exception.Message)"; Write-Output ''; Write-Output 'RESULT: FAIL'; exit 1 }
  else { Write-Check 'FAIL' 'Health' "HTTP $s from $health" }
}

try {
  # 2. Initialize
  $init = Invoke-Rpc '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"c4c-verify-ps1","version":"1.0.0"}}}'
  if ($init.Status -eq 401) {
    Write-Check 'FAIL' 'Initialize' 'HTTP 401: set $env:C4C_AUTH_TOKEN to the server''s token'
    Write-Output ''; Write-Output 'RESULT: FAIL'; exit 1
  }
  if ($init.Status -ne 200 -or $init.Json -eq $null -or $init.Json.result.serverInfo -eq $null) {
    Write-Check 'FAIL' 'Initialize' "HTTP $($init.Status)"
    Write-Output ''; Write-Output 'RESULT: FAIL'; exit 1
  }
  Write-Check 'PASS' 'Initialize' "$($init.Json.result.serverInfo.name) $($init.Json.result.serverInfo.version)"

  # 3. tools/list
  $list = Invoke-Rpc '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
  $names = @()
  if ($list.Json -ne $null) { $names = @($list.Json.result.tools | ForEach-Object { $_.name }) }
  $missing = @($core | Where-Object { $names -notcontains $_ })
  if ($list.Status -eq 200 -and $names.Count -gt 0 -and $missing.Count -eq 0) { Write-Check 'PASS' 'Tools' "$($names.Count) tools, all $($core.Count) core tools present" }
  else { Write-Check 'FAIL' 'Tools' ("HTTP $($list.Status), missing: " + ($missing -join ', ')) }

  # 4. lookup_citation
  $call = Invoke-Rpc '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"lookup_citation","arguments":{"citation":"12 CFR 1026.43"}}}'
  $res = $null; $inner = $null; $txt = ''
  if ($call.Json -ne $null) { $res = $call.Json.result }
  if ($res -ne $null) {
    $txt = (@($res.content | Where-Object { $_.type -eq 'text' } | ForEach-Object { $_.text }) -join "`n")
    try { $inner = $txt | ConvertFrom-Json } catch {}
  }
  if ($call.Status -eq 200 -and $res -ne $null -and -not $res.isError -and $txt -like '*1026.43*' -and $inner -ne $null -and -not $inner.error -and $inner.register_id) {
    Write-Check 'PASS' 'Lookup' "12 CFR 1026.43 -> $($inner.register_id)"
  } else {
    $snippet = $txt; if ($snippet.Length -gt 200) { $snippet = $snippet.Substring(0, 200) }
    Write-Check 'FAIL' 'Lookup' "HTTP $($call.Status): $snippet"
  }

  # 5. Without the token
  $anon = Invoke-Rpc '{"jsonrpc":"2.0","id":4,"method":"tools/list","params":{}}' $false
  if ($anon.Status -eq 401) { Write-Check 'PASS' 'Auth' 'a request without the token is refused (401)' }
  else { Write-Check 'WARN' 'Auth' "a request without the token got HTTP $($anon.Status); set C4C_AUTH_TOKEN on the server" }
} catch {
  Write-Check 'FAIL' 'Request' $_.Exception.Message
}

Write-Output ''
if ($script:failed) { Write-Output 'RESULT: FAIL'; exit 1 } else { Write-Output 'RESULT: PASS'; exit 0 }
