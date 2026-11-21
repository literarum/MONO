import test from 'node:test';import assert from 'node:assert/strict';
import {score,search,normalise} from '../public/settings-nav.js';
const entries=[
 {kind:'section',title:'Оформление',hint:'',section:'',extra:'тёмная светлая ночная'},
 {kind:'row',title:'Тема',hint:'«Как в системе» сама переключается',section:'Оформление',extra:'Как в системе Светлая Тёмная'},
 {kind:'row',title:'Курс доллара',hint:'Для пересчёта расходов в рубли.',section:'Расходы',extra:'курс доллар рубль'},
 {kind:'section',title:'Подключение Groq',hint:'',section:'',extra:'ключ api токен'},
 {kind:'row',title:'Обратный отсчёт',hint:'',section:'Запись',extra:'Нет 3 секунды Свой'}];
test('settings search finds by title, by plain-word synonym, by a prefix and through one typo; ё = е',()=>{
 assert.equal(search(entries,'тема')[0].title,'Тема');
 assert.equal(search(entries,'тёмная')[0].section||search(entries,'тёмная')[0].title,'Оформление');
 assert.equal(search(entries,'ключ')[0].title,'Подключение Groq');
 assert.equal(search(entries,'рубль')[0].title,'Курс доллара');
 assert.equal(search(entries,'отсчот')[0].title,'Обратный отсчёт','one typo');
 assert.equal(search([...entries,{kind:'section',title:'Запись',hint:'',section:'',extra:'отсчёт таймер'}],'отсчот')[0].title,'Обратный отсчёт','the row beats a section that only lists it among synonyms');
 assert.equal(search(entries,'курс долл')[0].title,'Курс доллара','several words, a prefix');
 assert.deepEqual(search(entries,'zzzz'),[]);assert.equal(normalise('Ёлка — «ТЕМА»'),'елка тема');
});
