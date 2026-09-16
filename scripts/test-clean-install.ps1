$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path $PSScriptRoot -Parent
$runner = 'stackport-install-regression-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
$testDir = Join-Path ([IO.Path]::GetTempPath()) $runner
function Invoke-Docker {
    & docker @args
    if ($LASTEXITCODE -ne 0) { throw "Docker command failed: $($args -join ' ')" }
}
New-Item -ItemType Directory -Path $testDir | Out-Null
try {
    Invoke-Docker build -t stackport-regression:local $repoRoot
    Invoke-Docker save -o (Join-Path $testDir 'image.tar') stackport-regression:local
    Invoke-Docker run -d --privileged --name $runner -e DOCKER_TLS_CERTDIR= -e STACKPORT_REGRESSION=1 docker:28-dind
    Invoke-Docker exec $runner mkdir -p /fixture
    foreach ($fixtureFile in @('stackport.sh', 'docker-compose.system.yml')) {
        $normalizedFile = Join-Path $testDir $fixtureFile
        $content = [IO.File]::ReadAllText((Join-Path $repoRoot $fixtureFile)).Replace("`r`n", "`n")
        [IO.File]::WriteAllText($normalizedFile, $content, [Text.UTF8Encoding]::new($false))
        Invoke-Docker cp $normalizedFile "${runner}:/fixture/$fixtureFile"
    }
    Invoke-Docker cp (Join-Path $testDir 'image.tar') "${runner}:/image.tar"
    $normalizedTest = Join-Path $testDir 'test.sh'
    $testContent = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'tests/clean-install.sh')).Replace("`r`n", "`n")
    [IO.File]::WriteAllText($normalizedTest, $testContent, [Text.UTF8Encoding]::new($false))
    Invoke-Docker cp $normalizedTest "${runner}:/test.sh"
    Invoke-Docker exec $runner sh -c 'apk add --no-cache bash >/dev/null; bash /test.sh'
} finally {
    & docker rm -fv $runner 2>$null | Out-Null
    $resolvedTestDir = [IO.Path]::GetFullPath($testDir)
    if ((Split-Path $resolvedTestDir -Leaf) -eq $runner -and $resolvedTestDir.StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath()))) {
        Remove-Item -LiteralPath $resolvedTestDir -Recurse -Force
    }
}
