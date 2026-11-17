import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const html=await readFile(new URL('../public/index.html',import.meta.url),'utf8');
const app=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
// These are explicit requested removals, not snapshots of incidental markup.
const removals=[
 ['record eyebrow',/RECORDING \/ STUDIO/],['record counter',/>01 \/ 04</],
 ['network badge',/id="network-label"/],['sidebar status',/class="sidebar-status"/],
 ['archive eyebrow',/YOUR ARCHIVE \/ ALL FILES/],
 ['archive description',/Ваши записи, заметки и готовые транскрипты\. Сохранены на этом устройстве\./],
 ['hero eyebrow',/ВАША ЛИЧНАЯ АУДИОСТУДИЯ/],['capture note',/01 \/ CAPTURE/],
 ['transcribe note',/02 \/ TRANSCRIBE/],['clarity caption',/DESIGNED FOR CLARITY — 2026/],
 ['section 01',/class="section-kicker">\/ 01/],['section aside',/ВСЁ ГЛАВНОЕ — НА ОДНОМ ЭКРАНЕ/],
 ['section 02',/class="section-kicker">\/ 02/],['preferences eyebrow',/PREFERENCES \/ CONTROL/],
 ['settings description',/Только необходимые параметры\. Всё остальное MONO берёт на себя\./],
 ['settings counter',/>04 \/ 04</],['theme description',/Настройте пространство под себя\./],
 ['FFmpeg description',/Обработка выполняется сервером с FFmpeg; временная шкала не сокращается\./],
 ['browser storage row',/<div class="privacy-row"><span>Записи хранятся в браузере/],
 ['cloud row',/<div class="privacy-row"><span>Облачная отправка/],
 ['backup hint',/Копия включает исходное аудио и правки\. Поддерживается в Chromium\/Edge\./],
 ['profile button',/id="open-settings"/]
];
for(const [label,pattern] of removals)test(`requested removal: ${label}`,()=>assert.doesNotMatch(html,pattern));
test('health and settings wiring no longer dereference removed UI',()=>{
 for(const id of ['network-label','sidebar-status-title','sidebar-status-caption','open-settings'])
  assert.ok(!app.includes(`$('#${id}')`),`Removed #${id} still consumed by application`);
});
test('navigation selection does not carry the decorative stripe element',()=>assert.doesNotMatch(html,/nav-active-indicator/));
