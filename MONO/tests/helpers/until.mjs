// Polls an (async) predicate in the page until it returns a truthy value.
// Playwright's waitForFunction treats a returned Promise as truthy and resolves at once,
// so async predicates must not be passed to it.
export async function until(page,fn,arg,{timeout=10000,polling=300}={}){
 const end=Date.now()+timeout;let last;
 for(;;){
  try{last=await page.evaluate(fn,arg);if(last)return last}catch(error){last=error}
  if(Date.now()>end)throw new Error(`until: condition not met in ${timeout} ms (last: ${last instanceof Error?last.message:JSON.stringify(last)})`);
  await new Promise(r=>setTimeout(r,polling));
 }
}
