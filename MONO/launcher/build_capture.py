"""Build a new self-contained Windows helper capsule, never overwrite output."""
import argparse,datetime,json,os,shutil,subprocess,sys,zipfile,hashlib
from pathlib import Path
from native_bundle import PAYLOAD,sha256,source_inventory,read_build_bundle
from local_core.paths import confined

SDK='10.0.401';RUNTIME='10.0.12';ROOT=Path(__file__).resolve().parents[1]
def run(args):
    result=subprocess.run(args,check=True,capture_output=True,text=True,encoding='utf-8',errors='replace')
    return result.stdout

def build(output):
    if os.name!='nt':raise RuntimeError('Build the Windows native helper on Windows')
    output=output.expanduser().absolute();output.mkdir(parents=True,exist_ok=False)
    sdk=run(['dotnet','--version']).strip()
    if sdk!=SDK:raise RuntimeError('Native build requires pinned .NET SDK '+SDK)
    source=ROOT/'native/windows';sources,source_hash=source_inventory(source)
    project=source/'MonoAudio.csproj'
    run(['dotnet','restore',str(project),'-r','win-x64','-p:RuntimeFrameworkVersion='+RUNTIME])
    packages=Path(run(['dotnet','nuget','locals','global-packages','--list']).strip().split(': ',1)[1])
    package=packages/'microsoft.netcore.app.runtime.win-x64'/RUNTIME
    archive=package/('microsoft.netcore.app.runtime.win-x64.'+RUNTIME+'.nupkg')
    signatures=run(['dotnet','nuget','verify',str(archive),'--all'])
    (output/'runtime-signature.log').write_text(signatures,encoding='utf-8')
    # Compare the extracted runtime used by the SDK with its signed payload.
    with zipfile.ZipFile(archive) as signed:
        for name in signed.namelist():
            if name.startswith('runtimes/win-x64/') and not name.endswith('/'):
                if sha256(confined(package,*name.split('/')))!=hashlib.sha256(signed.read(name)).hexdigest():raise RuntimeError('Extracted .NET runtime differs from signed package')
        license_text=signed.read('LICENSE.TXT');notices=signed.read('THIRD-PARTY-NOTICES.TXT')
    publish=output/'publish'
    command=['dotnet','publish',str(project),'--no-restore','-c','Release','-r','win-x64','--self-contained','true','-p:RuntimeFrameworkVersion='+RUNTIME,'-p:PublishSingleFile=true','-p:DebugType=None','-p:DebugSymbols=false','-p:ContinuousIntegrationBuild=true','-o',str(publish)]
    (output/'publish.log').write_text(run(command),encoding='utf-8')
    if source_inventory(source)!=(sources,source_hash):raise RuntimeError('Native sources changed during build')
    bundle=output/'bundle';bundle.mkdir()
    shutil.copy2(publish/'MonoAudio.exe',bundle/'MonoAudio.exe')
    (bundle/'DOTNET_LICENSE.txt').write_bytes(license_text);(bundle/'DOTNET_THIRD_PARTY_NOTICES.txt').write_bytes(notices)
    files=[{'path':name,'size':(bundle/name).stat().st_size,'sha256':sha256(bundle/name)} for name in sorted(PAYLOAD)]
    provenance={'schema':1,'protocol':1,'rid':'win-x64','sdk':sdk,'runtime':RUNTIME,'createdAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'sourceFiles':sources,'sourceHash':source_hash,'runtimePackageSha256':sha256(archive),'runtimeSignatureSha256':sha256(output/'runtime-signature.log'),'command':command,'files':files}
    (bundle/'PROVENANCE.json').write_text(json.dumps(provenance,ensure_ascii=False,indent=2),encoding='utf-8')
    read_build_bundle(bundle,source)
    return bundle

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--output',type=Path,required=True);args=parser.parse_args()
    print(json.dumps({'bundle':str(build(args.output)),'runtime':RUNTIME,'sdk':SDK}))
