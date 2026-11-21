"""Necessary FFmpeg redistribution gate, not complete legal clearance."""
import re,subprocess
from pathlib import Path

def classify(program,output):
    if program not in {'ffmpeg','ffprobe'} or not isinstance(output,str):
        raise RuntimeError('Unknown FFmpeg license declaration')
    text=output.lower()
    if any(marker in text for marker in ('--enable-nonfree','nonfree parts','non-free parts','not legally redistributable','unredistributable')):
        raise RuntimeError('Nonfree FFmpeg runtime is not redistributable; select a reviewed LGPL/GPL build')
    if not re.search(r'^'+program+r' version \S+',output,re.MULTILINE):
        raise RuntimeError('Missing or mismatched FFmpeg program identity')
    # Canonical FFmpeg LGPL2.1 output wraps its license title across lines.
    # Whitespace does not change its identity; unknown dotted versions do.
    declaration=' '.join(output.split())
    if re.search(r'GNU Lesser General Public License\b',declaration):
        if re.search(r'\bversion\s+2\.1(?![\w.])',declaration):return 'LGPL-2.1-or-later'
        if re.search(r'\bversion\s+3(?:\.0)?(?![\w.])',declaration):return 'LGPL-3.0-or-later'
    elif re.search(r'GNU General Public License\b',declaration):
        if re.search(r'\bversion\s+3(?:\.0)?(?![\w.])',declaration):return 'GPL-3.0-or-later'
        if re.search(r'\bversion\s+2(?:\.0)?(?![\w.])',declaration):return 'GPL-2.0-or-later'
    raise RuntimeError('Unknown FFmpeg license declaration; release input refused')

def inspect_license(executable:Path,program):
    try:
        result=subprocess.run([str(executable),'-L'],capture_output=True,text=True,encoding='utf-8',timeout=20,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
        if result.returncode!=0:raise RuntimeError('FFmpeg license inspection failed')
        return classify(program,result.stdout+'\n'+result.stderr)
    except (OSError,UnicodeError,subprocess.SubprocessError) as error:
        raise RuntimeError('FFmpeg license inspection failed') from error
