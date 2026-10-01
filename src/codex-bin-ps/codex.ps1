# Keep PowerShell arguments away from cmd.exe, including on Windows PowerShell 5.1.
function ConvertTo-WmuxCodexArg([string]$Value) {
    if ($Value.Length -gt 0 -and $Value -notmatch '[\s"]') { return $Value }
    $escaped = $Value -replace '(\\*)"', '$1$1\"'
    $escaped = $escaped -replace '(\\+)$', '$1$1'
    return '"' + $escaped + '"'
}
$wmuxCodexPreviousArgs = $env:WMUX_CODEX_ARGLINE
try {
    $argPassing = Get-Variable -Name PSNativeCommandArgumentPassing -ValueOnly -ErrorAction Ignore
    if ($argPassing -and "$argPassing" -ne 'Legacy') {
        & $env:WMUX_CODEX_RUNTIME $env:WMUX_CODEX_LAUNCHER @args
    } else {
        $env:WMUX_CODEX_ARGLINE = (@($env:WMUX_CODEX_LAUNCHER) + @($args) | ForEach-Object { ConvertTo-WmuxCodexArg ([string]$_) }) -join ' '
        & $env:WMUX_CODEX_RUNTIME --% %WMUX_CODEX_ARGLINE%
    }
    $wmuxCodexExit = $LASTEXITCODE
} finally {
    $env:WMUX_CODEX_ARGLINE = $wmuxCodexPreviousArgs
}
exit $wmuxCodexExit
