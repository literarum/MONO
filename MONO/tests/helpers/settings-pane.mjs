/** Settings show one section at a time (like System Settings): open the section that holds `selector`. */
export async function showPane(page,selector,{timeout=30000}={}){
 await page.waitForFunction(selector=>{const el=document.querySelector(selector);const card=el?.closest('.settings-card');if(!card?.id)return false;
  const link=document.querySelector(`#settings-index a[data-target="${card.id}"]`);if(!link)return false;if(card.classList.contains('pane-hidden'))link.click();return !card.classList.contains('pane-hidden')},selector,{timeout});
}
