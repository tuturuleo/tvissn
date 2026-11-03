<#
.SYNOPSIS
  Собственный сервер обмена кодами tvissn для Windows: ntfy за HTTPS-прокси Caddy.

.DESCRIPTION
  Скачивает ntfy и Caddy с GitHub (с проверкой контрольных сумм), выбирает домен по вашему белому IP
  (nip.io / sslip.io) или DuckDNS / свой домен, выпускает сертификат (Let's Encrypt, при неудаче ZeroSSL),
  регистрирует две службы Windows, правила брандмауэра и задачу, которая следит за сменой IP.
  Без параметров открывает меню.

  Команды:
    install    установить или переустановить (повторный запуск безопасен и меняет настройки)
    start      запустить службы
    stop       остановить службы
    restart    перезапустить службы
    enable     включить автозапуск вместе с Windows и запустить
    disable    остановить и запретить запуск (настройки и сертификат сохраняются)
    status     состояние служб, адрес, сертификат, проверка ответа
    check      диагностика сети без установки: белый IP, CGNAT, DNS, занятые порты
    update     скачать свежие ntfy и Caddy и перезапустить
    logs       последние строки журналов (-Lines N, -Follow)
    uninstall  удалить службы, правила и файлы (-KeepData оставляет настройки и сертификат)

.EXAMPLE
  .\tvissn-relay.ps1 install
  Определит белый IP сам, адрес будет вида https://1-2-3-4.nip.io

.EXAMPLE
  .\tvissn-relay.ps1 install -Dns duckdns -DuckDnsDomain myname -DuckDnsToken 0000-...
  Постоянный адрес https://myname.duckdns.org, который следует за динамическим IP.

.EXAMPLE
  .\tvissn-relay.ps1 install -Dns custom -Domain relay.example.com -Manual
  Свой домен (A-запись уже указывает на ваш IP), без автозапуска.
#>
[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [ValidateSet('menu', 'install', 'start', 'stop', 'restart', 'enable', 'disable', 'status', 'check', 'update', 'logs', 'uninstall', 'refresh', 'help')]
  [string]$Command = 'menu',
  # Как получить доменное имя: nip/sslip — из IP без регистрации, duckdns — постоянное имя, custom — свой домен.
  [ValidateSet('nip', 'sslip', 'duckdns', 'custom')]
  [string]$Dns,
  [string]$Domain,
  # Белый IP. По умолчанию определяется автоматически через внешние сервисы.
  [string]$PublicIp,
  [string]$DuckDnsDomain,
  [string]$DuckDnsToken,
  # Почта для уведомлений об истечении сертификата (необязательно).
  [string]$Email,
  # Локальный порт ntfy; снаружи доступен только Caddy на 80/443.
  [int]$Port = 0,
  # Не включать автозапуск при установке.
  [switch]$Manual,
  # Попробовать пробросить 80/443 на роутере через UPnP.
  [switch]$Upnp,
  # Разрешить любые топики, а не только tvissn_* (по умолчанию сервер обслуживает только расширение).
  [switch]$OpenTopics,
  # Тестовый центр сертификации Let's Encrypt: браузер такому сертификату не доверяет, только для проверки.
  [switch]$Staging,
  [switch]$KeepData,
  [int]$Lines = 40,
  [switch]$Follow
)

$ErrorActionPreference = 'Stop'
# Копия параметров скрипта: внутри функций $PSBoundParameters видит только их собственные параметры.
$Bound = @{} + $PSBoundParameters
$ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest в PowerShell 5.1 без этого качает в разы медленнее
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$InstallDir = Join-Path $env:ProgramFiles 'tvissn-relay'
$DataDir = Join-Path $env:ProgramData 'tvissn-relay'
$SettingsFile = Join-Path $DataDir 'settings.json'
$NtfyService = 'tvissn-ntfy'
$CaddyService = 'tvissn-caddy'
$TaskName = 'tvissn-relay-refresh'
$FirewallGroup = 'tvissn-relay'

# ---------- вывод ----------
function Say([string]$Text) { Write-Host $Text }
function Step([string]$Text) { Write-Host "`n== $Text" -ForegroundColor Cyan }
function Ok([string]$Text) { Write-Host "  [ok] $Text" -ForegroundColor Green }
function Warn([string]$Text) { Write-Host "  [!]  $Text" -ForegroundColor Yellow }
function Fail([string]$Text) { throw $Text }
# Сообщения программ в stderr при ErrorAction Stop в PowerShell 5.1 становятся исключениями; здесь они просто вывод.
function Invoke-Native([scriptblock]$Block) {
  $old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { & $Block } finally { $ErrorActionPreference = $old }
}

# ---------- права администратора ----------
function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  return (New-Object Security.Principal.WindowsPrincipal $id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}
function Assert-Admin {
  if (Test-Admin) { return }
  Say 'Нужны права администратора, открываю окно с повышенными правами...'
  $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-NoExit', '-File', "`"$PSCommandPath`"", $Command)
  foreach ($key in $Bound.Keys) {
    if ($key -eq 'Command') { continue }
    $value = $Bound[$key]
    if ($value -is [switch] -or $value -is [bool]) { if ([bool]$value) { $argList += "-$key" } }
    else { $argList += "-$key"; $argList += "`"$value`"" }
  }
  Start-Process powershell.exe -Verb RunAs -ArgumentList $argList
  exit
}

# ---------- настройки ----------
function Get-Settings {
  if (Test-Path $SettingsFile) {
    $json = Get-Content $SettingsFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $h = @{}; foreach ($p in $json.PSObject.Properties) { $h[$p.Name] = $p.Value }
    return $h
  }
  return @{ Dns = 'nip'; Port = 2586; Autostart = $true; OpenTopics = $false; Staging = $false }
}
function Save-Settings($s) {
  New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
  $s | ConvertTo-Json | Set-Content -Path $SettingsFile -Encoding UTF8
}
function Merge-Settings($s) {
  # Явно переданные параметры перекрывают сохранённые; остальное берётся из прошлой установки.
  foreach ($key in 'Dns', 'Domain', 'PublicIp', 'DuckDnsDomain', 'DuckDnsToken', 'Email') {
    if ($Bound.ContainsKey($key)) { $s[$key] = [string]$Bound[$key] }
  }
  if ($Bound.ContainsKey('Port') -and [int]$Bound.Port -gt 0) { $s.Port = [int]$Bound.Port }
  if ($Bound.ContainsKey('Manual')) { $s.Autostart = -not [bool]$Bound.Manual }
  if ($Bound.ContainsKey('OpenTopics')) { $s.OpenTopics = [bool]$Bound.OpenTopics }
  if ($Bound.ContainsKey('Staging')) { $s.Staging = [bool]$Bound.Staging }
  if ($Bound.ContainsKey('Upnp')) { $s.Upnp = [bool]$Bound.Upnp }
  if (-not $s.ContainsKey('Port') -or -not $s.Port) { $s.Port = 2586 }
  if (-not $s.ContainsKey('Dns') -or -not $s.Dns) { $s.Dns = 'nip' }
  return $s
}
function Get-Setting($s, [string]$Key, $Default = $null) {
  if ($s.ContainsKey($Key) -and $null -ne $s[$Key] -and "$($s[$Key])" -ne '') { return $s[$Key] }
  return $Default
}

# ---------- сеть ----------
function Test-IPv4([string]$Ip) { return $Ip -match '^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$' -and -not ($Ip.Split('.') | Where-Object { [int]$_ -gt 255 }) }
function Get-IpKind([string]$Ip) {
  $o = $Ip.Split('.') | ForEach-Object { [int]$_ }
  if ($o[0] -eq 10 -or ($o[0] -eq 172 -and $o[1] -ge 16 -and $o[1] -le 31) -or ($o[0] -eq 192 -and $o[1] -eq 168)) { return 'private' }
  if ($o[0] -eq 100 -and $o[1] -ge 64 -and $o[1] -le 127) { return 'cgnat' }
  if ($o[0] -eq 127 -or $o[0] -eq 0 -or ($o[0] -eq 169 -and $o[1] -eq 254)) { return 'local' }
  return 'public'
}
function Get-PublicIp {
  foreach ($url in 'https://api.ipify.org', 'https://ipv4.icanhazip.com', 'https://ifconfig.me/ip', 'https://2ip.ru') {
    try {
      $ip = (Invoke-WebRequest -UseBasicParsing -TimeoutSec 8 -Uri $url -UserAgent 'curl/8').Content.Trim()
      if (Test-IPv4 $ip) { return $ip }
    } catch { }
  }
  Fail 'Не удалось определить внешний IP. Укажите его вручную: -PublicIp 1.2.3.4'
}
function Get-LocalIp {
  $route = Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | Sort-Object RouteMetric, InterfaceMetric | Select-Object -First 1
  if (-not $route) { return $null }
  return (Get-NetIPAddress -AddressFamily IPv4 -InterfaceIndex $route.InterfaceIndex -ErrorAction SilentlyContinue | Select-Object -First 1).IPAddress
}
function Test-Cgnat {
  # Адрес из 100.64.0.0/10 на первых хопах — признак того, что провайдер держит вас за общим NAT.
  $hops = Invoke-Native { & tracert.exe -d -h 4 -w 800 8.8.8.8 2>&1 } | Out-String -Stream | Select-String -Pattern '(\d{1,3}\.){3}\d{1,3}' -AllMatches
  foreach ($line in $hops) { foreach ($m in $line.Matches) { if ((Test-IPv4 $m.Value) -and (Get-IpKind $m.Value) -eq 'cgnat') { return $true } } }
  return $false
}
function Show-Network([string]$Ip) {
  Step 'Сеть'
  Ok "Внешний IP: $Ip"
  $kind = Get-IpKind $Ip
  if ($kind -ne 'public') { Fail "Внешний IP $Ip не является публичным ($kind). Снаружи к компьютеру не подключиться." }
  $local = Get-LocalIp
  $direct = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -eq $Ip }).Count -gt 0
  if ($direct) { Ok 'Белый IP назначен прямо этому компьютеру, проброс портов не нужен.' }
  else {
    Say "  Локальный адрес компьютера: $local (за роутером)."
    Say "  На роутере нужно пробросить TCP 80 и 443 на $local (или запустить с -Upnp)."
    if (Test-Cgnat) { Warn 'Похоже на CGNAT провайдера (адрес 100.64.x.x по пути). Тогда белого IP у вас нет и проброс не поможет: попросите у провайдера белый IP или используйте VPS/туннель.' }
    else { Say '  Признаков CGNAT нет. Окончательно проверит выпуск сертификата: он возможен, только если порт 80 доступен из интернета.' }
  }
  return $local
}
function Get-PortOwner([int]$P) {
  $c = Get-NetTCPConnection -State Listen -LocalPort $P -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $c) { return $null }
  try { return (Get-Process -Id $c.OwningProcess).ProcessName } catch { return "PID $($c.OwningProcess)" }
}
function Assert-PortsFree {
  foreach ($p in 80, 443) {
    $owner = Get-PortOwner $p
    if ($owner -and $owner -ne 'caddy') {
      if ($owner -eq 'System') { Fail "Порт $p занят системой (обычно IIS или служба HTTP.sys). Отключите IIS/World Wide Web Publishing Service и повторите." }
      Fail "Порт $p занят программой $owner. Закройте её (часто это Skype, IIS, другой веб-сервер) и повторите."
    }
  }
  Ok 'Порты 80 и 443 свободны.'
}

# ---------- домен ----------
function Get-RelayDomain($s, [string]$Ip) {
  $dashed = $Ip -replace '\.', '-'
  switch ($s.Dns) {
    'nip' { return "$dashed.nip.io" }
    'sslip' { return "$dashed.sslip.io" }
    'duckdns' {
      $name = Get-Setting $s 'DuckDnsDomain'
      if (-not $name -or -not (Get-Setting $s 'DuckDnsToken')) { Fail 'Для DuckDNS укажите -DuckDnsDomain (имя без .duckdns.org) и -DuckDnsToken (с duckdns.org после входа).' }
      return ($name -replace '\.duckdns\.org$', '') + '.duckdns.org'
    }
    'custom' {
      $d = Get-Setting $s 'Domain'
      if (-not $d) { Fail 'Для своего домена укажите -Domain relay.example.com' }
      return $d.Trim().ToLower()
    }
  }
}
function Update-DuckDns($s, [string]$Ip) {
  $name = (Get-Setting $s 'DuckDnsDomain') -replace '\.duckdns\.org$', ''
  $r = (Invoke-WebRequest -UseBasicParsing -TimeoutSec 15 -Uri "https://www.duckdns.org/update?domains=$name&token=$(Get-Setting $s 'DuckDnsToken')&ip=$Ip").Content.Trim()
  if ($r -ne 'OK') { Fail 'DuckDNS отклонил обновление: проверьте имя и токен.' }
}
function Test-DomainResolves([string]$Name, [string]$Ip) {
  try {
    $a = @(Resolve-DnsName -Name $Name -Type A -DnsOnly -QuickTimeout -ErrorAction Stop | Where-Object { $_.Type -eq 'A' } | ForEach-Object { $_.IPAddress })
    if ($a -contains $Ip) { Ok "$Name указывает на $Ip"; return $true }
    Warn "$Name указывает на $($a -join ', '), а не на $Ip."
  } catch { Warn "$Name не разрешается через DNS этого компьютера." }
  return $false
}

# ---------- загрузка ----------
function Get-Release([string]$Repo) {
  return Invoke-RestMethod -UseBasicParsing -TimeoutSec 30 -Uri "https://api.github.com/repos/$Repo/releases/latest" -Headers @{ 'User-Agent' = 'tvissn-relay' }
}
function Install-Binary([string]$Repo, [string]$AssetPattern, [string]$ChecksumPattern, [string]$Algorithm, [string]$ExeName) {
  $release = Get-Release $Repo
  $asset = $release.assets | Where-Object { $_.name -match $AssetPattern } | Select-Object -First 1
  $sums = $release.assets | Where-Object { $_.name -match $ChecksumPattern } | Select-Object -First 1
  if (-not $asset -or -not $sums) { Fail "В последнем выпуске $Repo нет файла для Windows." }
  $tmp = Join-Path $env:TEMP ("tvissn-" + [guid]::NewGuid())
  New-Item -ItemType Directory -Path $tmp | Out-Null
  try {
    $zip = Join-Path $tmp $asset.name
    Say "  Скачиваю $($asset.name)..."
    Invoke-WebRequest -UseBasicParsing -Uri $asset.browser_download_url -OutFile $zip -TimeoutSec 600
    $expected = ((Invoke-WebRequest -UseBasicParsing -Uri $sums.browser_download_url -TimeoutSec 60).Content -split "`n" |
      Where-Object { $_ -match [regex]::Escape($asset.name) + '\s*$' } | Select-Object -First 1)
    if (-not $expected) { Fail "Контрольная сумма для $($asset.name) не найдена." }
    $expected = ($expected.Trim() -split '\s+')[0].ToLower()
    $actual = (Get-FileHash -Algorithm $Algorithm -Path $zip).Hash.ToLower()
    if ($actual -ne $expected) { Fail "Контрольная сумма $($asset.name) не совпала: файл повреждён или подменён." }
    Ok "$($asset.name): контрольная сумма $Algorithm совпала."
    Expand-Archive -Path $zip -DestinationPath $tmp -Force
    $exe = Get-ChildItem -Path $tmp -Recurse -Filter $ExeName | Select-Object -First 1
    if (-not $exe) { Fail "В архиве нет $ExeName." }
    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    Copy-Item -Force $exe.FullName (Join-Path $InstallDir $ExeName)
    return $release.tag_name
  } finally { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
}
function Install-Binaries([bool]$Force) {
  Step 'Программы'
  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'amd64' }
  if ($Force -or -not (Test-Path (Join-Path $InstallDir 'ntfy.exe'))) {
    # ntfy выпускается только для amd64; на ARM-Windows он работает через встроенную эмуляцию.
    $v = Install-Binary 'binwiederhier/ntfy' '_windows_amd64\.zip$' '^checksums\.txt$' 'SHA256' 'ntfy.exe'; Ok "ntfy $v"
  } else { Ok 'ntfy уже установлен.' }
  if ($Force -or -not (Test-Path (Join-Path $InstallDir 'caddy.exe'))) {
    $v = Install-Binary 'caddyserver/caddy' "_windows_$arch\.zip$" '_checksums\.txt$' 'SHA512' 'caddy.exe'; Ok "Caddy $v"
  } else { Ok 'Caddy уже установлен.' }
  # Копия скрипта рядом с программами: её запускает задача обновления IP, ею удобно управлять потом.
  if ($PSCommandPath -ne (Join-Path $InstallDir 'tvissn-relay.ps1')) { Copy-Item -Force $PSCommandPath (Join-Path $InstallDir 'tvissn-relay.ps1') }
}

# ---------- конфигурация ----------
function Protect-DataDir {
  # Токен DuckDNS и ключи сертификата читают только администраторы и SYSTEM.
  Invoke-Native { & icacls.exe $DataDir /inheritance:r /grant:r '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-18:(OI)(CI)F' /T } | Out-Null
}
function Write-Configs($s, [string]$RelayDomain) {
  $ntfyDir = Join-Path $DataDir 'ntfy'; $caddyDir = Join-Path $DataDir 'caddy'; $logDir = Join-Path $DataDir 'logs'
  New-Item -ItemType Directory -Force -Path $ntfyDir, $caddyDir, $logDir, (Join-Path $caddyDir 'data') | Out-Null
  $fwd = { param($p) $p -replace '\\', '/' }
  # По умолчанию анонимам доступны только топики расширения (tvissn_<хеш>), чтобы сервер не стал чужим почтовым ящиком.
  $acl = ''
  if (-not $s.OpenTopics) {
    $acl = @(
      "auth-file: `"$(& $fwd (Join-Path $ntfyDir 'user.db'))`"",
      'auth-default-access: "deny-all"',
      'auth-access:',
      '  - "*:tvissn_*:rw"'
    ) -join "`n"
  }
  $ntfy = @"
# Создано tvissn-relay.ps1; перезаписывается при install/refresh.
base-url: "https://$RelayDomain"
listen-http: "127.0.0.1:$($s.Port)"
behind-proxy: true
cache-file: "$(& $fwd (Join-Path $ntfyDir 'cache.db'))"
cache-duration: "2h"
web-root: "disable"
log-level: "info"
log-file: "$(& $fwd (Join-Path $logDir 'ntfy.log'))"
$acl
"@
  $global = @("storage file_system {`n`t`troot `"$(& $fwd (Join-Path $caddyDir 'data'))`"`n`t}")
  $email = Get-Setting $s 'Email'
  if ($email) { $global += "email $email" }
  if ($s.Staging) { $global += 'acme_ca https://acme-staging-v02.api.letsencrypt.org/directory' }
  $caddy = @"
# Создано tvissn-relay.ps1; перезаписывается при install/refresh.
{
	$($global -join "`n`t")
	log {
		output file "$(& $fwd (Join-Path $logDir 'caddy.log'))" {
			roll_size 10MiB
			roll_keep 3
		}
	}
}

$RelayDomain {
	reverse_proxy 127.0.0.1:$($s.Port) {
		# ntfy отдаёт подписку длинным потоком: пересылать без буферизации.
		flush_interval -1
	}
}
"@
  $utf8 = New-Object Text.UTF8Encoding $false   # без BOM: ntfy и Caddy его не ждут
  [IO.File]::WriteAllText((Join-Path $ntfyDir 'server.yml'), $ntfy, $utf8)
  [IO.File]::WriteAllText((Join-Path $caddyDir 'Caddyfile'), $caddy, $utf8)
  $caddyExe = Join-Path $InstallDir 'caddy.exe'; $caddyFile = Join-Path $caddyDir 'Caddyfile'
  $out = Invoke-Native { & $caddyExe validate --config $caddyFile --adapter caddyfile 2>&1 }
  if ($LASTEXITCODE -ne 0) { Fail "Caddy не принял конфигурацию:`n$($out | Out-String)" }
  Ok "Конфигурация для https://$RelayDomain записана."
}

# ---------- службы ----------
function Test-Service([string]$Name) { return [bool](Get-Service -Name $Name -ErrorAction SilentlyContinue) }
function Register-Services($s) {
  Step 'Службы Windows'
  $ntfyExe = Join-Path $InstallDir 'ntfy.exe'; $caddyExe = Join-Path $InstallDir 'caddy.exe'
  $definitions = @(
    @{ Name = $NtfyService; Display = 'tvissn relay: ntfy'; Bin = "`"$ntfyExe`" serve --config `"$(Join-Path $DataDir 'ntfy\server.yml')`"" },
    @{ Name = $CaddyService; Display = 'tvissn relay: Caddy HTTPS'; Bin = "`"$caddyExe`" run --config `"$(Join-Path $DataDir 'caddy\Caddyfile')`" --adapter caddyfile" }
  )
  $startType = if ($s.Autostart) { 'Automatic' } else { 'Manual' }
  $description = 'Сервер обмена кодами подключения tvissn. Управление: tvissn-relay.ps1'
  foreach ($d in $definitions) {
    # sc.exe из PowerShell 5.1 искажает вложенные кавычки в пути, поэтому New-Service и запись ImagePath напрямую.
    if (Test-Service $d.Name) {
      Stop-Service -Name $d.Name -Force -ErrorAction SilentlyContinue
      Set-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Services\$($d.Name)" -Name ImagePath -Value $d.Bin
      Set-Service -Name $d.Name -StartupType $startType -DisplayName $d.Display -Description $description
    } else {
      $extra = @{}; if ($d.Name -eq $CaddyService) { $extra.DependsOn = $NtfyService }
      New-Service -Name $d.Name -BinaryPathName $d.Bin -DisplayName $d.Display -Description $description -StartupType $startType @extra | Out-Null
    }
    # При падении перезапускать через 5 с, 5 с и 60 с.
    Invoke-Native { & sc.exe failure $d.Name reset= 86400 actions= restart/5000/restart/5000/restart/60000 } | Out-Null
  }
  Ok ("Службы $NtfyService и $CaddyService зарегистрированы, автозапуск: " + $(if ($s.Autostart) { 'включён' } else { 'выключен' }))
}
function Start-Relay {
  foreach ($n in $NtfyService, $CaddyService) {
    if (-not (Test-Service $n)) { Fail 'Службы не установлены: сначала выполните install.' }
    if ((Get-Service $n).StartType -eq 'Disabled') { Set-Service -Name $n -StartupType Manual }
    Start-Service -Name $n
  }
  Ok 'Службы запущены.'
}
function Stop-Relay {
  foreach ($n in $CaddyService, $NtfyService) { if (Test-Service $n) { Stop-Service -Name $n -Force -ErrorAction SilentlyContinue } }
  Ok 'Службы остановлены.'
}

# ---------- брандмауэр, UPnP, задача ----------
function Register-Firewall {
  Get-NetFirewallRule -Group $FirewallGroup -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  $caddyExe = Join-Path $InstallDir 'caddy.exe'
  New-NetFirewallRule -Group $FirewallGroup -DisplayName 'tvissn relay HTTPS (TCP 80, 443)' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 80, 443 -Program $caddyExe | Out-Null
  New-NetFirewallRule -Group $FirewallGroup -DisplayName 'tvissn relay HTTP/3 (UDP 443)' -Direction Inbound -Action Allow -Protocol UDP -LocalPort 443 -Program $caddyExe | Out-Null
  Ok 'Брандмауэр Windows: входящие 80/443 разрешены только для Caddy.'
}
function Set-Upnp([bool]$Add, [string]$LocalIp) {
  try {
    $maps = (New-Object -ComObject HNetCfg.NATUPnP).StaticPortMappingCollection
    if (-not $maps) { Warn 'Роутер не отвечает по UPnP (выключен в настройках роутера?). Пробросьте порты вручную.'; return }
    foreach ($p in 80, 443) {
      try { $maps.Remove($p, 'TCP') } catch { }
      if ($Add) { $maps.Add($p, 'TCP', $p, $LocalIp, $true, 'tvissn relay') | Out-Null }
    }
    if ($Add) { Ok "UPnP: роутер пробросил TCP 80 и 443 на $LocalIp." }
  } catch { Warn "UPnP не сработал: $($_.Exception.Message)" }
}
function Register-RefreshTask($s) {
  # Раз в 10 минут проверяет внешний IP: обновляет DuckDNS или пересобирает адрес nip.io/sslip.io.
  # Для своего домена следить нечего.
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  if ($s.Dns -eq 'custom') { return }
  $script = Join-Path $InstallDir 'tvissn-relay.ps1'
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$script`" refresh"
  $trigger = @(
    (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 10)),
    (New-ScheduledTaskTrigger -AtStartup)
  )
  $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings | Out-Null
  if (-not $s.Autostart) { Disable-ScheduledTask -TaskName $TaskName | Out-Null }
  Ok 'Задача слежения за IP зарегистрирована (каждые 10 минут).'
}

# ---------- проверки ----------
function Get-CertificateInfo([string]$RelayDomain) {
  $crt = Get-ChildItem -Path (Join-Path $DataDir 'caddy\data\certificates') -Recurse -Filter "$RelayDomain.crt" -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $crt) { return $null }
  $cert = New-Object Security.Cryptography.X509Certificates.X509Certificate2 $crt.FullName
  return @{ Issuer = $cert.Issuer; NotAfter = $cert.NotAfter; Staging = ($crt.FullName -match 'staging') }
}
function Test-LocalHealth($s) {
  try { return (Invoke-RestMethod -UseBasicParsing -TimeoutSec 5 -Uri "http://127.0.0.1:$($s.Port)/v1/health").healthy -eq $true } catch { return $false }
}
function Wait-Ready($s, [string]$RelayDomain) {
  Step 'Проверка'
  $deadline = (Get-Date).AddSeconds(30)
  while (-not (Test-LocalHealth $s)) {
    if ((Get-Date) -gt $deadline) { Fail "ntfy не отвечает. Журнал: $(Join-Path $DataDir 'logs\ntfy.log')" }
    Start-Sleep -Seconds 1
  }
  Ok 'ntfy отвечает локально.'
  Say '  Жду сертификат (до 2 минут)...'
  $deadline = (Get-Date).AddSeconds(120)
  while (-not (Get-CertificateInfo $RelayDomain)) {
    if ((Get-Date) -gt $deadline) {
      Warn 'Сертификат пока не выпущен. Обычно это значит, что порт 80 недоступен из интернета:'
      Say '    - проброшены ли TCP 80 и 443 на роутере на этот компьютер;'
      Say '    - нет ли CGNAT (выполните: tvissn-relay.ps1 check);'
      Say '    - не блокирует ли провайдер входящий порт 80.'
      Say "  Caddy продолжит попытки сам. Последние строки журнала:"
      Get-Content (Join-Path $DataDir 'logs\caddy.log') -Tail 8 -ErrorAction SilentlyContinue | ForEach-Object { Say "    $_" }
      return $false
    }
    Start-Sleep -Seconds 3
  }
  $c = Get-CertificateInfo $RelayDomain
  Ok "Сертификат выпущен: $($c.Issuer), действует до $($c.NotAfter.ToString('dd.MM.yyyy')). Caddy продлевает его сам."
  return $true
}
function Show-Result([string]$RelayDomain) {
  Step 'Готово'
  Say "  Адрес для расширения (Настройки -> Сервер обмена):"
  Write-Host "    https://$RelayDomain" -ForegroundColor Green
  Say "  Проверка для друга: открыть https://$RelayDomain/v1/health — должно быть {""healthy"":true}"
  Say '  Изнутри вашей сети адрес может не открываться (роутер без hairpin NAT) — это нормально, проверяйте снаружи.'
}

# ---------- команды ----------
function Invoke-Install {
  Assert-Admin
  $s = Merge-Settings (Get-Settings)
  $ip = Get-Setting $s 'PublicIp'
  if (-not $ip) { $ip = Get-PublicIp } elseif (-not (Test-IPv4 $ip)) { Fail "Некорректный IP: $ip" }
  $local = Show-Network $ip
  $relayDomain = Get-RelayDomain $s $ip
  Step "Домен ($($s.Dns))"
  if ($s.Dns -eq 'duckdns') { Update-DuckDns $s $ip; Ok 'DuckDNS обновлён.'; Start-Sleep -Seconds 2 }
  if (-not (Test-DomainResolves $relayDomain $ip)) { Warn 'Продолжаю: сертификат выпустится, когда DNS начнёт указывать на ваш IP.' }
  Stop-Relay | Out-Null
  Assert-PortsFree
  Install-Binaries $false
  Step 'Настройка'
  New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
  Protect-DataDir
  $s.CurrentIp = $ip; $s.RelayDomain = $relayDomain
  Write-Configs $s $relayDomain
  Save-Settings $s
  Register-Services $s
  Register-Firewall
  if ((Get-Setting $s 'Upnp' $false) -and $local) { Set-Upnp $true $local }
  Register-RefreshTask $s
  Start-Relay
  [void](Wait-Ready $s $relayDomain)
  Show-Result $relayDomain
}
function Invoke-Refresh {
  # Запускается задачей планировщика; тихо выходит, если ничего не изменилось.
  $s = Get-Settings
  if (-not (Test-Path $SettingsFile) -or $s.Dns -eq 'custom' -or (Get-Setting $s 'PublicIp')) { return }
  $ip = Get-PublicIp
  if ($s.Dns -eq 'duckdns') { if ($ip -ne $s.CurrentIp) { Update-DuckDns $s $ip; $s.CurrentIp = $ip; Save-Settings $s }; return }
  if ($ip -eq $s.CurrentIp) { return }
  # Для nip.io/sslip.io адрес зависит от IP: пишем новый домен, Caddy выпустит для него сертификат.
  $relayDomain = Get-RelayDomain $s $ip
  $s.CurrentIp = $ip; $s.RelayDomain = $relayDomain
  Write-Configs $s $relayDomain
  Save-Settings $s
  Restart-Service -Name $NtfyService -Force; Restart-Service -Name $CaddyService -Force
}
function Invoke-Enable {
  Assert-Admin
  $s = Get-Settings; $s.Autostart = $true; Save-Settings $s
  foreach ($n in $NtfyService, $CaddyService) { if (Test-Service $n) { Set-Service -Name $n -StartupType Automatic } }
  Enable-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue | Out-Null
  Start-Relay
  Ok 'Автозапуск включён: сервер будет стартовать вместе с Windows.'
}
function Invoke-Disable {
  Assert-Admin
  $s = Get-Settings; $s.Autostart = $false; Save-Settings $s
  Stop-Relay
  foreach ($n in $NtfyService, $CaddyService) { if (Test-Service $n) { Set-Service -Name $n -StartupType Disabled } }
  Disable-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue | Out-Null
  Ok 'Сервер выключен и не запустится сам. Включить снова: enable (с автозапуском) или start (один раз).'
}
function Invoke-Status {
  $s = Get-Settings
  if (-not (Test-Path $SettingsFile)) { Say 'Сервер не установлен. Выполните: tvissn-relay.ps1 install'; return }
  Step 'Состояние'
  foreach ($n in $NtfyService, $CaddyService) {
    $svc = Get-Service -Name $n -ErrorAction SilentlyContinue
    if ($svc) { Say ("  {0,-14} {1,-8} запуск: {2}" -f $n, $svc.Status, $svc.StartType) } else { Warn "$n не установлена" }
  }
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($task) { Say "  Слежение за IP: $($task.State)" }
  Say "  Адрес: https://$($s.RelayDomain)   (DNS: $($s.Dns), IP при настройке: $($s.CurrentIp))"
  if (Test-LocalHealth $s) { Ok 'ntfy отвечает.' } else { Warn 'ntfy не отвечает.' }
  $c = Get-CertificateInfo $s.RelayDomain
  if ($c) {
    $days = [int]($c.NotAfter - (Get-Date)).TotalDays
    Ok "Сертификат: $($c.Issuer), осталось $days дн."
    if ($c.Staging) { Warn 'Это тестовый сертификат (-Staging): браузер ему не доверяет. Переустановите без -Staging.' }
  } else { Warn 'Сертификата нет: смотрите logs.' }
  try {
    $ip = Get-PublicIp
    if ($ip -ne $s.CurrentIp -and -not (Get-Setting $s 'PublicIp')) { Warn "Внешний IP сменился на $ip; задача обновит адрес в течение 10 минут." }
  } catch { }
}
function Invoke-Check {
  $s = Merge-Settings (Get-Settings)
  $ip = Get-Setting $s 'PublicIp'; if (-not $ip) { $ip = Get-PublicIp }
  [void](Show-Network $ip)
  Step 'Порты'
  foreach ($p in 80, 443) { $o = Get-PortOwner $p; if ($o) { Say "  $p занят: $o" } else { Ok "$p свободен" } }
  Step 'DNS'
  $dashed = $ip -replace '\.', '-'
  [void](Test-DomainResolves "$dashed.nip.io" $ip)
  [void](Test-DomainResolves "$dashed.sslip.io" $ip)
  Say "`n  Попросите друга выполнить: nslookup $dashed.nip.io — в ответе должно быть $ip"
}
function Invoke-Update {
  Assert-Admin
  Stop-Relay
  Install-Binaries $true
  Start-Relay
  Ok 'Обновлено.'
}
function Invoke-Logs {
  $files = @((Join-Path $DataDir 'logs\caddy.log'), (Join-Path $DataDir 'logs\ntfy.log')) | Where-Object { Test-Path $_ }
  if (-not $files) { Say 'Журналов пока нет.'; return }
  if ($Follow) { Get-Content -Path $files -Tail $Lines -Wait; return }
  foreach ($f in $files) { Step $f; Get-Content -Path $f -Tail $Lines }
}
function Invoke-Uninstall {
  Assert-Admin
  $s = Get-Settings
  Stop-Relay
  foreach ($n in $CaddyService, $NtfyService) { if (Test-Service $n) { Invoke-Native { & sc.exe delete $n } | Out-Null } }
  Ok 'Службы удалены.'
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Get-NetFirewallRule -Group $FirewallGroup -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  if (Get-Setting $s 'Upnp' $false) { Set-Upnp $false '' }
  Ok 'Правила брандмауэра и задача удалены.'
  Remove-Item -Recurse -Force $InstallDir -ErrorAction SilentlyContinue
  if (-not $KeepData) { Remove-Item -Recurse -Force $DataDir -ErrorAction SilentlyContinue; Ok 'Программы, настройки и сертификаты удалены.' }
  else { Ok "Программы удалены; настройки и сертификат оставлены в $DataDir." }
}
function Show-Menu {
  while ($true) {
    Write-Host "`ntvissn relay — сервер обмена кодами" -ForegroundColor Cyan
    Say '  1  Установить / перенастроить'
    Say '  2  Состояние'
    Say '  3  Запустить          4  Остановить'
    Say '  5  Включить автозапуск 6  Выключить совсем'
    Say '  7  Диагностика сети   8  Журналы'
    Say '  9  Обновить программы 0  Удалить'
    Say '  Q  Выход'
    $choice = (Read-Host 'Выбор').Trim().ToUpper()
    try {
      switch ($choice) {
        '1' {
          $d = (Read-Host 'Домен: [1] nip.io  [2] sslip.io  [3] DuckDNS  [4] свой  (Enter = 1)').Trim()
          $dns = 'nip'
          if ($d -eq '2') { $dns = 'sslip' }
          if ($d -eq '3') { $dns = 'duckdns' }
          if ($d -eq '4') { $dns = 'custom' }
          $Bound.Dns = $dns
          if ($dns -eq 'duckdns') {
            $Bound.DuckDnsDomain = Read-Host 'Имя в DuckDNS (без .duckdns.org)'
            $Bound.DuckDnsToken = Read-Host 'Токен DuckDNS'
          }
          if ($dns -eq 'custom') { $Bound.Domain = Read-Host 'Домен (A-запись на ваш IP)' }
          $ipIn = (Read-Host 'Белый IP (Enter = определить автоматически)').Trim()
          if ($ipIn) { $Bound.PublicIp = $ipIn } else { $Bound.Remove('PublicIp') }
          $Bound.Manual = ((Read-Host 'Запускать вместе с Windows? [Y/n]').Trim().ToLower() -eq 'n')
          $Bound.Upnp = ((Read-Host 'Пробросить порты на роутере через UPnP? [y/N]').Trim().ToLower() -eq 'y')
          Invoke-Install
        }
        '2' { Invoke-Status }
        '3' { Start-Relay }
        '4' { Stop-Relay }
        '5' { Invoke-Enable }
        '6' { Invoke-Disable }
        '7' { Invoke-Check }
        '8' { Invoke-Logs }
        '9' { Invoke-Update }
        '0' { if ((Read-Host 'Удалить сервер полностью? [y/N]').Trim().ToLower() -eq 'y') { Invoke-Uninstall } }
        'Q' { return }
      }
    } catch { Write-Host "Ошибка: $($_.Exception.Message)" -ForegroundColor Red }
  }
}

try {
  switch ($Command) {
    'menu' { Assert-Admin; Show-Menu }
    'install' { Invoke-Install }
    'start' { Assert-Admin; Start-Relay }
    'stop' { Assert-Admin; Stop-Relay }
    'restart' { Assert-Admin; Stop-Relay; Start-Relay }
    'enable' { Invoke-Enable }
    'disable' { Invoke-Disable }
    'status' { Invoke-Status }
    'check' { Invoke-Check }
    'update' { Invoke-Update }
    'logs' { Invoke-Logs }
    'uninstall' { Invoke-Uninstall }
    'refresh' { Invoke-Refresh }
    'help' { Get-Help $PSCommandPath -Detailed }
  }
} catch {
  Write-Host "`nОшибка: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
