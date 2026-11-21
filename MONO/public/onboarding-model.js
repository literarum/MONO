export function nextSetupStep({library,key,progress}){
 if(!library.libraryConfigured)return 'folder';
 if(!library.libraryAvailable)return 'reconnect';
 if(progress.completed)return null;
 if(!key.configured&&!progress.keySkipped)return 'key';
 return 'sound';
}
