"""Small allowlisted protocol shared by the packaged worker and development CLI."""
import json

MAX_LINE=65536
class CoreError(Exception):
    def __init__(self,code,message,retryable=False):
        self.code,self.message,self.retryable=code,message,retryable
        super().__init__(message)

def decode(line):
    if len(line.encode('utf-8'))>MAX_LINE:raise CoreError('TOO_LARGE','Сообщение слишком большое')
    try:value=json.loads(line)
    except (ValueError,TypeError):raise CoreError('INVALID_JSON','Некорректное сообщение')
    if not isinstance(value,dict) or value.get('v')!=1 or not isinstance(value.get('id'),str) or not 1<=len(value['id'])<=100 or not isinstance(value.get('method'),str) or not isinstance(value.get('params',{}),dict):
        raise CoreError('INVALID_REQUEST','Некорректный запрос')
    return value

def error_reply(request_id,error):
    if not isinstance(error,CoreError):error=CoreError('INTERNAL','Операция не выполнена')
    return {'v':1,'id':request_id,'error':{'code':error.code,'message':error.message,'retryable':error.retryable}}
