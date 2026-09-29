# wmux CLI shim for PowerShell.
#
# PowerShell resolves a .ps1 ahead of every PATHEXT entry, so when this dir is on
# PATH it is THIS file — not wmux.cmd — that a bare `wmux …` runs in PowerShell,
# and cmd.exe's parser never sees the arguments.
#
# That is the whole point (issue #154). PowerShell strips the quoting the user
# wrote before invoking a .cmd, and cmd.exe then re-reads `>`, `|`, `&` and `<`
# inside free-form text as shell syntax — turning
#     wmux browser eval "document.title.length>0"
# into an evaluation whose output is redirected into a new file named `0`: exit 0,
# no output, no warning. The redirect is applied to cmd.exe's own invocation line,
# before wmux.cmd starts, so no amount of quoting inside the batch file can undo
# it; only keeping cmd.exe out of the path can. `@args` splats the arguments
# through natively, with no shell in between.
#
# Runs the Node pipe client via the $WMUX_CLI path wmux injects, falling back to
# the copy shipped next to this shim — same contract as wmux.cmd and the bash
# shim, so all three stay interchangeable.
$wmuxCli = if ($env:WMUX_CLI) { $env:WMUX_CLI } else { Join-Path $PSScriptRoot '..\cli\wmux.js' }

# Issue #247: "natively" is only true from PowerShell 7.3 on. Before that (and
# under $PSNativeCommandArgumentPassing = 'Legacy'), PowerShell builds node's
# command line by wrapping an argument that contains a space in "…" and does
# NOT escape the double quotes inside it, so
#     wmux agent spawn --cmd 'powershell -Command "Start-Sleep 30"' --label C
# reached node as several argv entries with the inner quotes eaten — and every
# flag after the split was silently misread. Windows PowerShell 5.1, the one
# every Windows machine has, is on the wrong side of that line.
#
# The fix is to build the command line ourselves, by the MSVCRT /
# CommandLineToArgvW rules node's argv is parsed with, and hand it over through
# `--%` (stop-parsing), which passes the text on untouched after expanding
# %VAR% references. Pre-escaping arguments for `@args` instead does NOT work:
# legacy mode decides whether to add its own quotes by scanning for spaces
# OUTSIDE "…" pairs, and it cannot see `\"`, so an argument like `"a b"`
# escapes to `\"a b\"`, looks quoted, goes out unwrapped and splits at the space.
# `--%` keeps `&`, so stdout still feeds the pipeline (`$x = wmux identify`) —
# a hand-rolled Process.Start would print straight to the console instead.
#
# Where the variable exists and is not 'Legacy' (7.3+ 'Standard'/'Windows' —
# the latter only differs for cmd/wscript/msiexec-style targets, not node),
# PowerShell already escapes correctly, and escaping here too would double it.
$legacyArgPassing = $true
$argPassing = Get-Variable -Name PSNativeCommandArgumentPassing -ValueOnly -ErrorAction Ignore
if ($argPassing -and "$argPassing" -ne 'Legacy') { $legacyArgPassing = $false }

if (-not $legacyArgPassing) {
    & node $wmuxCli @args
    exit $LASTEXITCODE
}

function ConvertTo-WmuxNativeArg([string]$Value) {
    # Nothing to protect: pass as-is (an EMPTY argument still needs "" or it
    # vanishes from argv altogether).
    if ($Value.Length -gt 0 -and $Value -notmatch '[\s"]') { return $Value }
    # Backslashes are literal EXCEPT in front of a quote: a run of N before a "
    # becomes 2N plus the \" itself, and a run at the very end is doubled so it
    # does not escape the closing quote we add.
    $escaped = $Value -replace '(\\*)"', '$1$1\"'
    $escaped = $escaped -replace '(\\+)$', '$1$1'
    return '"' + $escaped + '"'
}

$line = (@($wmuxCli) + @($args) | ForEach-Object { ConvertTo-WmuxNativeArg ([string]$_) }) -join ' '
# A `%NAME%` inside an argument would be expanded by `--%` too, and the value
# reaches this line only through such a reference — so it is expanded exactly
# once, from here, and never re-scanned.
$env:WMUX_PS_ARGLINE = $line
try {
    & node --% %WMUX_PS_ARGLINE%
} finally {
    Remove-Item Env:\WMUX_PS_ARGLINE -ErrorAction Ignore
}
exit $LASTEXITCODE
