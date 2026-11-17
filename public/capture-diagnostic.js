/** Shared, closed diagnostic vocabulary. Never include raw exception/device data. */
const operations=new Set(['start','refresh']);
const stages=new Set(['status','access','devices','context','worklet','acquire','graph','resume']);
const codes=new Set(['ACCESS_DENIED','ACCESS_TIMEOUT','DEVICE_LOST','DEVICE_BUSY','BROWSER_AUDIO_ERROR','BROWSER_AUDIO_UNAVAILABLE','CAPTURE_BUSY','CAPTURE_CONNECTION_LOST','INVALID_CAPTURE_FORMAT','CAPTURE_NOT_READY','LIBRARY_BUSY','ARCHIVE_IO_ERROR']);
const names=new Set(['NotAllowedError','SecurityError','NotFoundError','OverconstrainedError','NotReadableError','NotSupportedError','InvalidStateError','EncodingError','TypeError','ReferenceError','Error','LibraryError','OtherError']);
export function captureDiagnostic(operation,stage,error,code){return {operation,stage,code:codes.has(code)?code:'BROWSER_AUDIO_ERROR',errorName:names.has(error?.name)?error.name:'OtherError'}}
export function validCaptureDiagnostic(value){return value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===4&&operations.has(value.operation)&&stages.has(value.stage)&&codes.has(value.code)&&names.has(value.errorName)}
