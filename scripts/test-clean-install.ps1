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
    Invoke-Docker cp (Join-Path $repoRoot 'stackport.sh') "${runner}:/fixture/stackport.sh"
    Invoke-Docker cp (Join-Path $repoRoot 'docker-compose.system.yml') "${runner}:/fixture/docker-compose.system.yml"
    Invoke-Docker cp (Join-Path $testDir 'image.tar') "${runner}:/image.tar"
    Invoke-Docker cp (Join-Path $PSScriptRoot 'tests/clean-install.sh') "${runner}:/test.sh"
    # Normalize Windows checkout line endings before running Bash.
    Invoke-Docker exec $runner sh -c 'sed -i "s/\r$//" /test.sh /fixture/stackport.sh /fixture/docker-compose.system.yml; apk add --no-cache bash >/dev/null; bash /test.sh'
} finally {
    & docker rm -fv $runner 2>$null | Out-Null
    $resolvedTestDir = [IO.Path]::GetFullPath($testDir)
    if ((Split-Path $resolvedTestDir -Leaf) -eq $runner -and $resolvedTestDir.StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath()))) {
        Remove-Item -LiteralPath $resolvedTestDir -Recurse -Force
    }
}
