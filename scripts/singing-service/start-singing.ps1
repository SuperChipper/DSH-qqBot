param([switch]$Status, [switch]$Stop)
$ErrorActionPreference = 'Stop'
$VoiceLab = Split-Path -Parent $PSScriptRoot
$Data = Join-Path (Split-Path -Parent $VoiceLab) 'tmp\singing-service'
$Url = 'http://127.0.0.1:8766'
$Headers = @{}
if ($env:SING_SERVICE_TOKEN) { $Headers.Authorization = 'Bearer ' + $env:SING_SERVICE_TOKEN }

function Get-SingingHealth {
    try {
        $health = Invoke-RestMethod -Uri "$Url/health" -Headers $Headers -TimeoutSec 2
        if ($health.service -ne 'voice-lab-singing') { throw 'Port 8766 belongs to another service' }
        return $health
    } catch [System.Net.Http.HttpRequestException] { return $null }
    catch [System.Threading.Tasks.TaskCanceledException] { return $null }
}

if ($Status) {
    $health = Get-SingingHealth
    if ($health) { $health | ConvertTo-Json -Depth 5 } else { Write-Output 'SING 8766: stopped' }
    return
}
if ($Stop) {
    if (Get-SingingHealth) {
        Invoke-RestMethod -Method Post -Uri "$Url/shutdown" -Headers $Headers -ContentType 'application/json' -Body '{}' | Out-Null
        $deadline = [DateTime]::UtcNow.AddSeconds(35)
        while ((Get-SingingHealth) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 300 }
        if (Get-SingingHealth) { throw 'Singing service shutdown timed out; inspect logs' }
    }
    Write-Output 'SING 8766: stopped'
    return
}

$mutex = [Threading.Mutex]::new($false, 'Local\DshVoiceLabSingingStartup')
$held = $false
try {
    try { $held = $mutex.WaitOne(30000) } catch [Threading.AbandonedMutexException] { $held = $true }
    if (-not $held) { throw 'Another singing service startup is still in progress' }
    $health = Get-SingingHealth
    if ($health) {
        if (-not $health.ready) { throw 'Singing service is running but its queue worker is unhealthy' }
        Write-Output 'SING 8766: already running'
        return
    }
    # The port probe distinguishes an absent service from a foreign listener or auth failure.
    $tcp = [Net.Sockets.TcpClient]::new()
    try {
        $tcp.Connect('127.0.0.1', 8766)
        throw 'Port 8766 is occupied but the singing health endpoint is unavailable'
    } catch [Net.Sockets.SocketException] { }
    finally { $tcp.Dispose() }
    New-Item -ItemType Directory -Force -Path $Data | Out-Null
    $py = Join-Path $VoiceLab 'env\python.exe'
    $script = Join-Path $PSScriptRoot 'sing_service.py'
    $log = Join-Path $Data 'service.log'
    $command = '"' + $py + '" -B "' + $script + '" --data-dir "' + $Data + '" --log "' + $log + '"'
    if ($env:SING_SERVICE_TOKEN) {
        # WMI children inherit the WMI host environment, not the calling shell's variables.
        $tokenFile = Join-Path $Data 'service-token.txt'
        [IO.File]::WriteAllText($tokenFile, $env:SING_SERVICE_TOKEN, [Text.UTF8Encoding]::new($false))
        $command += ' --token-file "' + $tokenFile + '"'
    }
    $startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }
    $result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
        CommandLine = $command; CurrentDirectory = $VoiceLab; ProcessStartupInformation = $startup
    }
    if ($result.ReturnValue -ne 0) { throw "Singing startup failed: $($result.ReturnValue)" }
    $deadline = [DateTime]::UtcNow.AddSeconds(20)
    do {
        Start-Sleep -Milliseconds 250
        $health = Get-SingingHealth
        if ($health -and $health.ready) { Write-Output "SING 8766: ready (pid $($health.pid))"; return }
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "Singing service did not become ready; see $log"
} finally {
    if ($held) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
