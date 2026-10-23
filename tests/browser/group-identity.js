'use strict';

const assert = require('assert');
const { evaluate } = require('./harness/cdp-client');

module.exports = function createGroupIdentityScenarios({ readTestScript, instrumentContentSource }) {
async function runAngularGroupIdentityAssertions(client, subjectRegressionOnly = false, ageSourceRegressionOnly = false, emptySectionRegressionOnly = false, expandIdentityRegressionOnly = false, visibleIdFormatRegressionOnly = false) {
  const pageSource = readTestScript('src/bosun/group-identity-page.js');
  const readerSource = readTestScript('src/bosun/group-identity.js');
  const mainScript = await client.send('Page.addScriptToEvaluateOnNewDocument', { source: pageSource });
  const readerScript = await client.send('Page.addScriptToEvaluateOnNewDocument', {
    source: readerSource, worldName: 'bh-group-identity-test'
  });
  let mainRemoved = false;
  try {
    await evaluate(client, `(async () => {
      const frame = document.createElement('iframe'); frame.id = 'bh-angular-identity-test'; frame.src = '/?angular-identity-test';
      await new Promise(resolve => { frame.onload = resolve; document.body.appendChild(frame); });
      const win = frame.contentWindow, doc = frame.contentDocument;
      win.fixtureGroups = { NeedAck: [], Acknowledged: [] }; win.fixtureScopes = new WeakMap();
      win.angular = { element(node) { return {
        scope: () => { win.beforeScopeRead?.(node); return win.fixtureScopes.get(node); },
        isolateScope: () => ({ groups: win.fixtureGroups[node.getAttribute('ts-ack-group').split('.').at(-1)] })
      }; } };
      win.fixtureBodies = [];
      for (const [section, id] of [['NeedAck', 9601], ['Acknowledged', 9602]]) {
        const child = { Alert: 'synthetic.angular', AlertKey: 'synthetic.angular{instance=' + section + '}',
          Subject: 'synthetic child ' + section, Ago: '1m', State: { Id: id, CurrentStatus: 'warning', Actions: [{ Type: 'Note' }] } };
        const group = { Subject: 'snapshot subject ' + section, Children: [child] };
        win.fixtureGroups[section].push(group);
        const root = doc.createElement('div'); root.setAttribute('ts-ack-group', 'schedule.Groups.' + section);
        root.innerHTML = '<div class="panel-group"><div class="panel" ng-repeat="group in groups" ng-init="idx = $index">' +
          '<div class="panel-heading" ng-click="collapse(idx)"><h4 class="panel-title">' +
          '<span ng-bind="group.Subject">native subject ' + section + '</span></h4></div>' +
          '<div class="panel-body panel-group" ng-if="shown[idx]"><div class="panel" ng-repeat="child in group.Children">' +
          '<div class="panel-heading" ng-click="toggle()"><h4 class="panel-title">' +
          '<span ng-show="state.Id">#' + id + '</span><span ng-bind="child.Subject || child.AlertKey">synthetic child ' + section + '</span>' +
          '<span ts-since="child.Ago">1m</span></h4></div></div></div></div></div>';
        doc.body.appendChild(root);
        const panel = root.querySelector('.panel'); win.fixtureScopes.set(panel, { group });
        win.fixtureBodies.push({ section, panel, body: panel.querySelector('.panel-body') });
      }
    })()`);
    const tree = await client.send('Page.getFrameTree');
    const frame = tree.frameTree.childFrames.find(entry => entry.frame.url.includes('angular-identity-test')).frame;
    const world = await client.send('Page.createIsolatedWorld', { frameId: frame.id, worldName: 'bh-group-identity-test' });
    const run = async expression => {
      const response = await client.send('Runtime.evaluate', { contextId: world.executionContextId,
        expression, awaitPromise: true, returnByValue: true });
      if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || 'Angular identity fixture failed');
      return response.result.value;
    };
    const sources = ['src/settings/settings.js', 'src/bosun/alerts-data.js', 'src/bosun/needack-severity.js', 'src/bosun/priority-alerts.js'];
    if (subjectRegressionOnly || ageSourceRegressionOnly || emptySectionRegressionOnly || expandIdentityRegressionOnly) sources.push('src/bosun/single-alert-age.js');
    const content = instrumentContentSource(readTestScript('src/bosun/content.js'));
    await run(`(() => {
      globalThis.BosunHelperLocalConfig = { bosunHosts: ['not-current.invalid'] };
      ${sources.map(file => readTestScript(file)).join('\n')}
      if (${ageSourceRegressionOnly}) {
        globalThis.ageSourceClock = Date.parse('2031-02-03T12:00:00Z');
        const create = BosunHelperSingleAlertAge.createSingleAlertAge;
        BosunHelperSingleAlertAge.createSingleAlertAge = options => create({ ...options, now: () => ageSourceClock });
      }
      ${content}
      const hooks = __BosunHelperBrowserTest;
      const settings = JSON.parse(JSON.stringify(BosunHelperSettings.DEFAULTS));
      settings.features.priorityAlerts = true; settings.preferences.priorityRuleAction = true; settings.preferences.priorityCritical = false;
      settings.preferences.priorityShowAcknowledged = true;
      settings.priorityRules.exactAlertNames = ['synthetic.angular'];
      hooks.applySettingsSnapshot(settings, { initial: true });
      globalThis.fixturePayload = { Groups: {} };
      for (const [section, id] of [['NeedAck', 9601], ['Acknowledged', 9602]]) {
        fixturePayload.Groups[section] = [{ Subject: 'snapshot subject ' + section, Children: [{
          Alert: 'synthetic.angular', AlertKey: 'synthetic.angular{instance=' + section + '}',
          Subject: 'synthetic child ' + section, Ago: '1m', State: { Id: id, CurrentStatus: 'warning', Actions: [{ Type: 'Note' }] }
        }] }];
      }
      hooks.applyAlertsPayload(fixturePayload, { source: 'follower' });
      globalThis.fixtureState = () => Array.from(document.querySelectorAll('[ng-repeat="group in groups"]')).map(panel => {
        const heading = panel.querySelector(':scope > .panel-heading');
        return { priority: !!heading.querySelector('.bosun-priority-marker'), accent: heading.classList.contains('bosun-priority-row'),
          parentNote: !!heading.querySelector('.bosun-has-note-icon.bosun-parent-marker'),
          children: panel.querySelectorAll('[ng-repeat="child in group.Children"]').length,
          childNote: !!panel.querySelector('.bosun-has-note-icon:not(.bosun-parent-marker)') };
      });
    })()`);
    assert.ok((await run('fixtureState()')).every(row => row.priority && row.accent));
    assert.strictEqual((await run('fixtureState()'))[0].childNote, true);
    const mutateMain = script => evaluate(client, `document.getElementById('bh-angular-identity-test').contentWindow.eval(${JSON.stringify(script)})`);
    if (subjectRegressionOnly || ageSourceRegressionOnly || emptySectionRegressionOnly || expandIdentityRegressionOnly) {
      // Настоящий защищённый читатель MAIN/ISOLATED подтверждает принадлежность панели независимо
      // от диагностического сравнения ID между снимками.
      await mutateMain(`fixtureBodies.forEach(entry => {
        entry.body.remove();
        entry.panel.querySelector('[ng-bind="group.Subject"]').textContent = fixtureGroups[entry.section][0].Subject;
        const node = document.createElement('span'); node.className = 'pull-right ng-binding'; node.textContent = '1 alerts';
        entry.panel.querySelector('.panel-title').appendChild(node);
        entry.ageTemplate = entry.panel.cloneNode(true);
      });
      ageBaseModels = JSON.parse(JSON.stringify(fixtureGroups));
      resetAgeFixture = () => {
        beforeScopeRead = null;
        fixtureGroups = JSON.parse(JSON.stringify(ageBaseModels));
        fixtureBodies.forEach(entry => {
          const panel = entry.ageTemplate.cloneNode(true);
          document.querySelector('[ts-ack-group="schedule.Groups.' + entry.section + '"] .panel-group').replaceChildren(panel);
          fixtureScopes.set(panel, { group: fixtureGroups[entry.section][0] }); entry.panel = panel;
        });
      };`);
      if (expandIdentityRegressionOnly) {
        // Настоящее доказательство MAIN/ISOLATED; одной идентичности родительской модели недостаточно.
        const results = [];
        for (const section of ['NeedAck', 'Acknowledged']) {
          for (const conflict of ['none', 'visible-id', 'visible-child-model-key', 'parent-id', 'parent-key']) {
            await mutateMain('resetAgeFixture();');
            await run(`(() => {
              const hooks=__BosunHelperBrowserTest,diag=hooks.singleAlertAge.diagnostics;
              diag.clear();
              const initial=JSON.parse(JSON.stringify(fixturePayload));
              for(const type of ['NeedAck','Acknowledged'])initial.Groups[type][0].Children[0].Ago=new Date(Date.now()-12*60000).toISOString();
              hooks.applyAlertsPayload(initial,{source:'follower'});
              const panel=document.querySelector('[ts-ack-group="schedule.Groups.${section}"] .panel-group > .panel');
              globalThis.expandInitial=panel.querySelector('.pull-right.ng-binding').textContent;
              globalThis.expandPayload=JSON.parse(JSON.stringify(initial));
              expandPayload.Groups.${section}[0].Subject='synthetic revised group subject';
              expandPayload.Groups.${section}[0].Children[0].Ago=new Date(Date.now()-6*60000).toISOString();
              diag.start();hooks.applyAlertsPayload(expandPayload,{source:'follower'});
              globalThis.expandCollapsed=panel.querySelector('.pull-right.ng-binding').textContent;
              globalThis.expandBefore=Object.values(diag.report().panels).find(row=>row.section==='${section}');
            })()`);
            const visibleProof = await mutateMain(`(() => {
              const entry=fixtureBodies.find(row=>row.section==='${section}');
              const group=fixtureGroups[entry.section][0],child=group.Children[0];
              if('${conflict}'==='parent-id')child.State.Id+=100;
              if('${conflict}'==='parent-key')child.AlertKey='synthetic.conflict{instance=other}';
              const visibleChild='${conflict}'==='visible-child-model-key'?JSON.parse(JSON.stringify(child)):child;
              if('${conflict}'==='visible-child-model-key')visibleChild.AlertKey='synthetic.conflict{instance=visible}';
              const body=document.createElement('div');body.className='panel-body panel-group';
              body.innerHTML='<div class="panel" ng-repeat="child in group.Children"><div class="panel-heading">'+
                '<span ng-show="state.Id"></span><span ng-bind="child.Subject || child.AlertKey"></span>'+
                '<span ts-since="child.Ago">29m-ago</span></div></div>';
              const childPanel=body.firstElementChild;
              childPanel.querySelector('[ng-show="state.Id"]').textContent='#'+(child.State.Id+('${conflict}'==='visible-id'?200:0));
              childPanel.querySelector('[ng-bind="child.Subject || child.AlertKey"]').textContent=child.Subject;
              fixtureScopes.set(childPanel,{child:visibleChild});entry.panel.append(body);
              const parentScope=angular.element(entry.panel).scope(),childScope=angular.element(childPanel).scope();
              return {childReferenceMatches:childScope.child===parentScope.group.Children[0],
                visibleIdMatchesModel:childPanel.querySelector('[ng-show="state.Id"]').textContent==='#'+parentScope.group.Children[0].State.Id,
                childIdMatchesParent:childScope.child.State.Id===parentScope.group.Children[0].State.Id,
                childKeyMatchesParent:childScope.child.AlertKey===parentScope.group.Children[0].AlertKey};
            })()`);
            const result = await run(`(() => {
              const hooks=__BosunHelperBrowserTest,api=hooks.singleAlertAge,diag=api.diagnostics;
              const panel=document.querySelector('[ts-ack-group="schedule.Groups.${section}"] .panel-group > .panel');
              const count=()=>panel.querySelector('.pull-right.ng-binding').textContent;
              const reader=BosunHelperGroupIdentity.read,expandedReader=BosunHelperGroupIdentity.readExpandedSingleton;
              const identity=reader(panel),current=expandPayload.Groups.${section}[0];
              const domKey=hooks.buildGroupMarkerKeyFromDom(panel);
              let calls=0,expandedReaderCalls=0,requests=0;
              const originalFetch=globalThis.fetch;
              BosunHelperGroupIdentity.read=(...args)=>{calls++;return reader(...args);};
              BosunHelperGroupIdentity.readExpandedSingleton=(...args)=>{expandedReaderCalls++;return expandedReader(...args);};
              globalThis.fetch=()=>{requests++;throw Error('Unexpected synthetic request');};
              try {
                api.refresh();const expanded=count(),report=diag.report();
                const row=Object.values(report.panels).find(row=>row.section==='${section}');
                const expandedCalls=calls;
                panel.querySelector('.panel-body').remove();api.refresh();
                return {section:'${section}',conflict:'${conflict}',initial:expandInitial,collapsed:expandCollapsed,
                  collapsedReason:expandBefore.presentationReason,expanded,recollapsed:count(),
                  parentReaderMatchesSnapshot:identity?.section==='${section}'&&identity.children.length===1&&
                    identity.children[0].id===String(current.Children[0].State.Id)&&identity.children[0].key===current.Children[0].AlertKey,
                  keyMatches:domKey===hooks.buildGroupMarkerKeyFromData(current),
                  onlyGroupSubjectDiffers:domKey===hooks.buildGroupMarkerKeyFromData({...current,Subject:panel.querySelector('[ng-bind="group.Subject"]').textContent}),
                  identityReason:row.identityReason,presentationReason:row.presentationReason,
                  fallbackAttempted:row.fallbackAttempted,readerCalled:row.fallbackReaderCalled,
                  fallbackReason:row.fallbackReason,restoreCountApplied:row.restoreCountApplied,
                  sameGeneration:row.generation===expandBefore.generation,expandedCalls,expandedReaderCalls,requests};
              } finally {BosunHelperGroupIdentity.read=reader;BosunHelperGroupIdentity.readExpandedSingleton=expandedReader;globalThis.fetch=originalFetch;diag.clear();}
            })()`);
            Object.assign(result,visibleProof);results.push(result);
            assert.strictEqual(result.initial,'12m-ago');assert.strictEqual(result.collapsed,'6m-ago');
            assert.strictEqual(result.collapsedReason,'model-identity-match');
            assert.strictEqual(result.sameGeneration,true);
            assert.strictEqual(result.requests,0);
            if(conflict==='none') {
              assert.strictEqual(result.parentReaderMatchesSnapshot,true);
              assert.strictEqual(result.childReferenceMatches,true);assert.strictEqual(result.visibleIdMatchesModel,true);
              assert.strictEqual(result.childIdMatchesParent,true);assert.strictEqual(result.childKeyMatchesParent,true);
              assert.strictEqual(result.keyMatches,false);assert.strictEqual(result.onlyGroupSubjectDiffers,true);
              assert.strictEqual(result.recollapsed,'6m-ago');
              assert.strictEqual(result.expandedReaderCalls,1);assert.strictEqual(result.expandedCalls,0);
              assert.strictEqual(result.presentationReason,'expanded-model-identity-match');
              assert.strictEqual(result.identityReason,'strong-key-mismatch');
              assert.strictEqual(result.restoreCountApplied,false);
            } else {
              assert.strictEqual(result.expanded,'1 alerts','A real or unverified child conflict must remain fail-closed');
              if(conflict.startsWith('visible-'))assert.strictEqual(result.parentReaderMatchesSnapshot,true,
                'The current parent reader does not verify the visible child scope or visible ID');
              else assert.strictEqual(result.parentReaderMatchesSnapshot,false);
            }
          }
        }
        await mutateMain(`expandAgeFixture=section=>{
          const entry=fixtureBodies.find(row=>row.section===section),child=fixtureGroups[section][0].Children[0];
          const body=document.createElement('div');body.className='panel-body panel-group';
          body.innerHTML='<div class="panel" ng-repeat="child in group.Children"><div class="panel-heading">'+
            '<span ng-show="state.Id"></span><span ng-bind="child.Subject || child.AlertKey"></span>'+
            '<span ts-since="child.Ago">29m-ago</span></div></div>';
          body.querySelector('[ng-show="state.Id"]').textContent='#'+child.State.Id+':';
          body.querySelector('[ng-bind="child.Subject || child.AlertKey"]').textContent=child.Subject;
          fixtureScopes.set(body.firstElementChild,{child});entry.panel.append(body);
        };`);
        const prepareExpanded = async section => {
          await mutateMain(`resetAgeFixture();expandAgeFixture('${section}');`);
          await run(`(() => {
            const hooks=__BosunHelperBrowserTest;hooks.singleAlertAge.diagnostics.clear();
            hooks.setFeature('singleAlertAge',true);
            globalThis.expandedCurrent=JSON.parse(JSON.stringify(fixturePayload));
            for(const type of ['NeedAck','Acknowledged'])expandedCurrent.Groups[type][0].Children[0].Ago=new Date(Date.now()-6*60000).toISOString();
            expandedCurrent.Groups.${section}[0].Subject='synthetic revised group subject';
            hooks.applyAlertsPayload(expandedCurrent,{source:'follower'});
          })()`);
          assert.strictEqual(await run(`document.querySelector('[ts-ack-group="schedule.Groups.${section}"] .pull-right.ng-binding').textContent`),'6m-ago');
        };
        if(visibleIdFormatRegressionOnly || process.argv.includes('--single-alert-age-visible-id-format-regression')) {
          // Публичный штатный шаблон без корпоративного DOM и данных:
          // bosun-monitor/bosun, cmd/bosun/web/static/partials/alertstate.html:
          // <span ng-show="state.Id">#{{state.Id}}:</span>
          const matrix=[
            ['plain',true,true],['outer-whitespace',true,true],['space-after-hash',true,false],
            ['wrapped',true,true],['upstream-colon',true,true],['wrapped-colon',true,true],
            ['space-before-colon',false,true],['prefix-text',false,true],['suffix-text',false,true],
            ['zero-width-suffix',false,true],['two-id-tokens',false,true],['no-hash',false,false],
            ['leading-zero',false,false],['split-digits',false,false],['double-colon',false,true],
            ['colon-suffix-text',false,true],['zero',false,false],['too-long',false,false],
            ['unsafe-integer',false,false,'visible-id-mismatch'],['wrong-id-colon',false,false,'visible-id-mismatch'],
            ['leading-zero-colon',false,false],['decimal-colon',false,true]
          ];
          let matrixCases=0;
          for(const section of ['NeedAck','Acknowledged'])for(const idType of ['number','string'])for(const [format,accepted,commonKey,rejection='visible-id-format'] of matrix) {
            await prepareExpanded(section);
            await mutateMain(`(() => {
              const entry=fixtureBodies.find(row=>row.section==='${section}'),child=fixtureGroups[entry.section][0].Children[0];
              if('${idType}'==='string')child.State.Id=String(child.State.Id);
              const childPanel=entry.panel.querySelector('[ng-repeat="child in group.Children"]');
              fixtureScopes.set(childPanel,{child,state:child.State});
              const node=childPanel.querySelector('[ng-show="state.Id"]'),id=String(child.State.Id),format='${format}';
              const text={plain:'#'+id,'outer-whitespace':' \\t#'+id+'\\n ', 'space-after-hash':'# \\t'+id,
                'upstream-colon':'#'+id+':','space-before-colon':'#'+id+' :','prefix-text':'synthetic #'+id,
                'suffix-text':'#'+id+' synthetic','zero-width-suffix':'#'+id+'\\u200b',
                'two-id-tokens':'#'+id+'#'+id,'no-hash':id,'leading-zero':'#0'+id,
                'split-digits':'#'+id.slice(0,2)+' '+id.slice(2),'double-colon':'#'+id+'::',
                'colon-suffix-text':'#'+id+': synthetic','zero':'#0:','too-long':'#12345678901234567:',
                'unsafe-integer':'#9007199254740993:','wrong-id-colon':'#'+(Number(id)+100)+':',
                'leading-zero-colon':'#0'+id+':','decimal-colon':'#'+id+'.5:'};
              if(format==='wrapped'||format==='wrapped-colon'){
                node.replaceChildren();const prefix=document.createElement('b'),digits=document.createElement('i');
                prefix.textContent='#';digits.textContent=id;node.append(prefix,digits);
                if(format==='wrapped-colon')node.append(document.createTextNode(':'));
              }else node.textContent=text[format];
            })()`);
            const result=await run(`(() => {
              const hooks=__BosunHelperBrowserTest,panel=document.querySelector('[ts-ack-group="schedule.Groups.${section}"] .panel-group > .panel');
              const identity=BosunHelperGroupIdentity.readExpandedSingleton(panel),source=expandedCurrent.Groups.${section}[0];
              return {accepted:identity?.rejected!==true&&identity?.children?.length===1,reason:identity?.reason,
                commonKey:hooks.buildGroupMarkerKeyFromDom(panel)===hooks.buildGroupMarkerKeyFromData({...source,Subject:panel.querySelector('[ng-bind="group.Subject"]').textContent})};
            })()`);
            assert.strictEqual(result.accepted,accepted,section+'/'+idType+'/'+format+': strict MAIN parser');
            assert.strictEqual(result.commonKey,commonKey,section+'/'+idType+'/'+format+': ordinary composite parser');
            if(!accepted)assert.strictEqual(result.reason,rejection);
            matrixCases++;
          }
          const results=[];
          for(const section of ['NeedAck','Acknowledged']) {
            await prepareExpanded(section);
            const proof=await mutateMain(`(() => {
              const entry=fixtureBodies.find(row=>row.section==='${section}'),group=fixtureGroups[entry.section][0],child=group.Children[0];
              const childPanel=entry.panel.querySelector('[ng-repeat="child in group.Children"]');
              fixtureScopes.set(childPanel,{child,state:child.State});
              const node=childPanel.querySelector('[ng-show="state.Id"]');node.textContent='#'+child.State.Id+':';
              return {sameChild:angular.element(childPanel).scope().child===angular.element(entry.panel).scope().group.Children[0],
                sameState:angular.element(childPanel).scope().state===child.State,
                canonicalModelId:node.textContent==='#'+String(child.State.Id)+':'};
            })()`);
            assert.ok(proof.sameChild&&proof.sameState&&proof.canonicalModelId);
            const result=await run(`(() => {
              const hooks=__BosunHelperBrowserTest,api=hooks.singleAlertAge,diag=api.diagnostics;
              const panel=document.querySelector('[ts-ack-group="schedule.Groups.${section}"] .panel-group > .panel');
              const body=panel.querySelector('.panel-body'),node=body.querySelector('[ng-show="state.Id"]');
              const originalText=node.textContent,count=()=>panel.querySelector('.pull-right.ng-binding').textContent;
              const identity=BosunHelperGroupIdentity.read(panel),source=expandedCurrent.Groups.${section}[0];
              const pairMatches=identity?.section==='${section}'&&identity.children.length===1&&
                identity.children[0].id===String(source.Children[0].State.Id)&&identity.children[0].key===source.Children[0].AlertKey;
              diag.start();const expanded=[],collapsed=[],generations=[];
              for(let i=0;i<3;i++){
                api.refresh();expanded.push(count());
                generations.push(Object.values(diag.report().panels).find(row=>row.section==='${section}').generation);
                body.remove();api.refresh();collapsed.push(count());panel.append(body);
              }
              api.refresh();const report=diag.report(),row=Object.values(report.panels).find(row=>row.section==='${section}');
              return {section:'${section}',pairMatches,expanded,collapsed,sameGeneration:generations.every(value=>value===generations[0]),
                generation:row.generation,reason:row.expandedReaderReason,identityReason:row.identityReason,
                presentationReason:row.presentationReason,restoreApplied:report.totals.restoreCountApplied,ageSource:row.ageSource,
                originalFormatUnchanged:node.textContent===originalText};
            })()`);
            assert.strictEqual(result.pairMatches,true);assert.strictEqual(result.sameGeneration,true);
            assert.ok(result.collapsed.every(value=>value==='6m-ago'));assert.strictEqual(result.reason,'not-reported');
            assert.strictEqual(result.presentationReason,'expanded-model-identity-match');assert.strictEqual(result.restoreApplied,0);
            assert.strictEqual(result.ageSource,'snapshot-child');
            assert.strictEqual(result.identityReason,'strong-key-mismatch');assert.strictEqual(result.originalFormatUnchanged,true);
            await mutateMain(`(() => {
              const entry=fixtureBodies.find(row=>row.section==='${section}');
              fixtureGroups[entry.section][0].Subject='synthetic revised group subject';
              entry.panel.querySelector('[ng-bind="group.Subject"]').textContent='synthetic revised group subject';
            })()`);
            const aligned=await run(`(() => {
              const hooks=__BosunHelperBrowserTest,diag=hooks.singleAlertAge.diagnostics;
              const panel=document.querySelector('[ts-ack-group="schedule.Groups.${section}"] .panel-group > .panel');
              const original=BosunHelperGroupIdentity.readExpandedSingleton;let calls=0;
              BosunHelperGroupIdentity.readExpandedSingleton=(...args)=>{calls++;return original(...args);};
              try {
                const next=JSON.parse(JSON.stringify(expandedCurrent));
                next.Groups.${section}[0].Children[0].Ago=new Date(Date.now()-3*60000).toISOString();
                hooks.applyAlertsPayload(next,{source:'leader'});
                const row=Object.values(diag.report().panels).find(value=>value.section==='${section}');
                return {text:panel.querySelector('.pull-right.ng-binding').textContent,identityReason:row.identityReason,
                  generation:row.generation,source:row.ageSource,readerCalls:calls,
                  colonStillPresent:panel.querySelector('[ng-show="state.Id"]').textContent.endsWith(':')};
              } finally {BosunHelperGroupIdentity.readExpandedSingleton=original;diag.clear();}
            })()`);
            assert.strictEqual(aligned.text,'3m-ago');assert.strictEqual(aligned.identityReason,'group-key');
            assert.strictEqual(aligned.source,'snapshot-child');assert.strictEqual(aligned.readerCalls,0);
            assert.strictEqual(aligned.colonStillPresent,true);assert.ok(aligned.generation>result.generation);
            results.push(result);
          }
          console.log('Visible ID format regressions passed ('+matrixCases+' synthetic format/type/section cases, three toggles, stable generation and current Ago)');
          for(const result of results)assert.ok(result.expanded.every(value=>value==='6m-ago'),
            'The upstream #ID: format must preserve a proven singleton age during Subject skew');
          return;
        }
        let negativeCases=0;
        for(const section of ['NeedAck','Acknowledged']) {
          const opposite=section==='NeedAck'?'Acknowledged':'NeedAck';
          // Новое поколение и повторные переключения всегда используют текущее Ago.
          await prepareExpanded(section);
          const positive=await run(`(() => {
            const hooks=__BosunHelperBrowserTest,panel=document.querySelector('[ts-ack-group="schedule.Groups.${section}"] .panel-group > .panel');
            const before=fixtureState().map(row=>({priority:row.priority,accent:row.accent,parentNote:row.parentNote}));
            const count=()=>panel.querySelector('.pull-right.ng-binding').textContent;
            const body=panel.querySelector('.panel-body'),texts=[count()];
            for(let i=0;i<2;i++){body.remove();hooks.singleAlertAge.refresh();texts.push(count());panel.append(body);hooks.singleAlertAge.refresh();texts.push(count());}
            expandedCurrent=JSON.parse(JSON.stringify(expandedCurrent));
            expandedCurrent.Groups.${section}[0].Subject='synthetic newer expanded subject';
            expandedCurrent.Groups.${section}[0].Children[0].Ago=new Date(Date.now()-3*60000).toISOString();
            hooks.applyAlertsPayload(expandedCurrent,{source:'leader'});const updated=count();
            const after=fixtureState().map(row=>({priority:row.priority,accent:row.accent,parentNote:row.parentNote}));
            return {texts,updated,native:panel.querySelector('[ts-since="child.Ago"]').textContent,markersUnchanged:JSON.stringify(before)===JSON.stringify(after)};
          })()`);
          assert.ok(positive.texts.every(text=>text==='6m-ago'));assert.strictEqual(positive.updated,'3m-ago');
          assert.strictEqual(positive.native,'29m-ago');assert.strictEqual(positive.markersUnchanged,true);
          for(const scenario of ['child-scope-missing','foreign-child','ambiguous-model','visible-multiple','model-multiple',
            'missing-visible-id','duplicate-visible-id','conflicting-state-alias',
            'inherited-child','inherited-foreign','state-alias-clone','state-alias-clone-key','child-binding-accessor','child-binding-missing','visible-id-format',
            'duplicate-id','duplicate-key','cross-id','cross-key','snapshot-multiple','section-moved','duplicate-subject','duplicate-group-key',
            'dom-subject-collision','dom-subject-duplicate',
            'reader-unavailable','reader-rejected','reader-threw','main-reader-exception','reader-code-private','promise-resolve','promise-reject','composite-other-child','disabled']) {
            await prepareExpanded(section);
            await mutateMain(`(() => {
              const scenario='${scenario}',entry=fixtureBodies.find(row=>row.section==='${section}');
              const group=fixtureGroups[entry.section][0],childPanel=entry.panel.querySelector('[ng-repeat="child in group.Children"]');
              if(scenario==='child-scope-missing')fixtureScopes.delete(childPanel);
              if(scenario==='foreign-child')fixtureScopes.set(childPanel,{child:JSON.parse(JSON.stringify(group.Children[0]))});
              if(scenario==='ambiguous-model')fixtureGroups[entry.section].push(group);
              if(scenario==='visible-multiple')childPanel.parentElement.append(childPanel.cloneNode(true));
              if(scenario==='model-multiple')group.Children.push({State:{Id:9809},AlertKey:'synthetic.extra{instance=model}'});
              if(scenario==='missing-visible-id')childPanel.querySelector('[ng-show="state.Id"]').remove();
              if(scenario==='duplicate-visible-id'){
                const id=childPanel.querySelector('[ng-show="state.Id"]');id.parentElement.append(id.cloneNode(true));
              }
              if(scenario==='conflicting-state-alias')fixtureScopes.set(childPanel,{child:group.Children[0],state:{Id:9813}});
              if(scenario==='inherited-child')fixtureScopes.set(childPanel,Object.create({child:group.Children[0]}));
              if(scenario==='inherited-foreign')fixtureScopes.set(childPanel,Object.create({child:JSON.parse(JSON.stringify(group.Children[0]))}));
              if(scenario==='state-alias-clone'||scenario==='state-alias-clone-key'){
                const state={...group.Children[0].State};if(scenario==='state-alias-clone-key')state.AlertKey=group.Children[0].AlertKey;
                fixtureScopes.set(childPanel,{child:group.Children[0],state});
              }
              if(scenario==='child-binding-missing')fixtureScopes.set(childPanel,{});
              if(scenario==='child-binding-accessor'){
                fixtureAccessorReads=0;const scope={};Object.defineProperty(scope,'child',{get(){fixtureAccessorReads++;return group.Children[0];}});fixtureScopes.set(childPanel,scope);
              }
              if(scenario==='visible-id-format')childPanel.querySelector('[ng-show="state.Id"]').textContent+=' synthetic decoration';
              if(scenario==='main-reader-exception')beforeScopeRead=()=>{throw Error('PRIVATE_SENTINEL_NEVER_EXPORT');};
              if(scenario==='composite-other-child')childPanel.querySelector('[ng-show="state.Id"]').textContent='#9810';
            })()`);
            const negative=await run(`(async()=>{
              const scenario='${scenario}',section='${section}',opposite='${opposite}',hooks=__BosunHelperBrowserTest;
              const panel=document.querySelector('[ts-ack-group="schedule.Groups.'+section+'"] .panel-group > .panel');
              const reader=BosunHelperGroupIdentity.readExpandedSingleton,originalFetch=globalThis.fetch;
              const diag=hooks.singleAlertAge.diagnostics;diag.start();
              let requests=0;globalThis.fetch=()=>{requests++;throw Error('Unexpected synthetic request');};
              try {
                const next=JSON.parse(JSON.stringify(expandedCurrent)),group=next.Groups[section][0],child=group.Children[0];
                const extra=JSON.parse(JSON.stringify(group));extra.Subject='synthetic extra group';
                extra.Children[0].State.Id=9811;extra.Children[0].AlertKey='synthetic.extra{instance=other}';
                if(scenario==='duplicate-id'||scenario==='cross-id')extra.Children[0].State.Id=child.State.Id;
                if(scenario==='duplicate-key'||scenario==='cross-key')extra.Children[0].AlertKey=child.AlertKey;
                if(scenario==='duplicate-id'||scenario==='duplicate-key')next.Groups[section].push(extra);
                if(scenario==='cross-id'||scenario==='cross-key')next.Groups[opposite].push(extra);
                if(scenario==='snapshot-multiple')group.Children.push(extra.Children[0]);
                if(scenario==='section-moved'){next.Groups[section]=[];next.Groups[opposite].push(group);}
                if(scenario==='duplicate-subject'){extra.Subject=group.Subject;next.Groups[section].push(extra);}
                if(scenario==='duplicate-group-key')next.Groups[section].push(JSON.parse(JSON.stringify(group)));
                if(scenario.startsWith('dom-subject-')){
                  extra.Subject=panel.querySelector('[ng-bind="group.Subject"]').textContent;next.Groups[section].push(extra);
                  if(scenario==='dom-subject-duplicate'){
                    const second=JSON.parse(JSON.stringify(extra));second.Children[0].State.Id=9812;
                    second.Children[0].AlertKey='synthetic.extra{instance=second}';next.Groups[section].push(second);
                  }
                }
                if(scenario==='reader-unavailable')BosunHelperGroupIdentity.readExpandedSingleton=undefined;
                if(scenario==='reader-rejected')BosunHelperGroupIdentity.readExpandedSingleton=()=>({rejected:true});
                if(scenario==='reader-code-private')BosunHelperGroupIdentity.readExpandedSingleton=()=>({rejected:true,reason:'PRIVATE_SENTINEL_NEVER_EXPORT'});
                if(scenario==='reader-threw')BosunHelperGroupIdentity.readExpandedSingleton=()=>{throw Error('Synthetic reader failure');};
                if(scenario==='promise-resolve')BosunHelperGroupIdentity.readExpandedSingleton=()=>Promise.resolve(reader(panel));
                if(scenario==='promise-reject')BosunHelperGroupIdentity.readExpandedSingleton=()=>Promise.reject(Error('Synthetic reader failure'));
                // Even a tuple returned by a bad adapter cannot bypass the composite-key comparison.
                if(scenario==='composite-other-child')BosunHelperGroupIdentity.readExpandedSingleton=()=>({section,children:[{id:String(child.State.Id),key:child.AlertKey}]});
                if(scenario==='disabled')hooks.setFeature('singleAlertAge',false);
                hooks.applyAlertsPayload(next,{source:'leader'});await Promise.resolve();await Promise.resolve();
                const report=diag.report(),row=Object.values(report.panels).find(row=>row.section===section);
                for(const forbidden of ['synthetic.angular','synthetic.extra','snapshot subject','9601','9602','PRIVATE_SENTINEL_NEVER_EXPORT'])
                  if(JSON.stringify(report).includes(forbidden))throw Error('Expanded diagnostic privacy regression');
                return {text:panel.querySelector('.pull-right.ng-binding').textContent,requests,reason:row?.expandedReaderReason,
                  reasonCounts:report.totals.expandedReaderReasons||{}};
              } finally {diag.clear();BosunHelperGroupIdentity.readExpandedSingleton=reader;globalThis.fetch=originalFetch;}
            })()`);
            assert.ok(/^\d+ alerts$/.test(negative.text),section+'/'+scenario+': unconfirmed expanded identity must show count');
            assert.strictEqual(negative.requests,0);negativeCases++;
            const mainReasons={'child-scope-missing':'child-scope-unavailable','foreign-child':'child-parent-reference-mismatch',
              'ambiguous-model':'parent-reader-rejected','model-multiple':'parent-not-singleton','missing-visible-id':'visible-id-count',
              'duplicate-visible-id':'visible-id-count','conflicting-state-alias':'state-alias-reference-mismatch',
              'inherited-child':'child-binding-inherited-parent','inherited-foreign':'child-binding-inherited-other',
              'state-alias-clone':'state-alias-same-id-no-key','state-alias-clone-key':'state-alias-same-identity',
              'child-binding-accessor':'child-binding-accessor','child-binding-missing':'child-binding-missing','visible-id-format':'visible-id-format',
              'reader-rejected':'unknown','main-reader-exception':'reader-exception','reader-code-private':'unknown'};
            if(mainReasons[scenario]){
              assert.strictEqual(negative.reason,mainReasons[scenario],section+'/'+scenario+': fixed MAIN rejection code');
              assert.strictEqual(negative.reasonCounts[mainReasons[scenario]],1);
            }
            if(scenario==='child-binding-accessor')assert.strictEqual(await mutateMain('fixtureAccessorReads'),0,'Diagnostics must not invoke binding getters');
          }
          for(const mutation of ['panel','heading','count','root','child','child-heading','section','snapshot','disable','parent-scope','child-scope','child-state','child-key']) {
            await prepareExpanded(section);
            await run(`(() => {
              const panel=document.querySelector('[ts-ack-group="schedule.Groups.${section}"] .panel-group > .panel');
              globalThis.expandedOldCount=panel.querySelector('.pull-right.ng-binding');globalThis.expandedRaceWrites=[];
              const descriptor=Object.getOwnPropertyDescriptor(Node.prototype,'textContent');
              Object.defineProperty(expandedOldCount,'textContent',{configurable:true,get(){return descriptor.get.call(this);},set(value){expandedRaceWrites.push(value);descriptor.set.call(this,value);}});
              const hooks=__BosunHelperBrowserTest;
              if(globalThis.expandedSnapshotHandler)window.removeEventListener('bh-expanded-new-snapshot',expandedSnapshotHandler);
              if(globalThis.expandedDisableHandler)window.removeEventListener('bh-expanded-disable',expandedDisableHandler);
              globalThis.expandedSnapshotHandler=()=>{
                const newest=JSON.parse(JSON.stringify(expandedCurrent));newest.Groups.${section}[0].Children[0].Ago=new Date(Date.now()-2*60000).toISOString();
                hooks.applyAlertsPayload(newest,{source:'leader'});
              };
              globalThis.expandedDisableHandler=()=>hooks.setFeature('singleAlertAge',false);
              window.addEventListener('bh-expanded-new-snapshot',expandedSnapshotHandler,{once:true});
              window.addEventListener('bh-expanded-disable',expandedDisableHandler,{once:true});
            })()`);
            await mutateMain(`(() => {
              let reads=0;
              beforeScopeRead=node=>{
                const entry=fixtureBodies.find(row=>row.section==='${section}');
                if(node!==entry.panel||++reads!==3)return;beforeScopeRead=null;
                const panel=entry.panel,mutation='${mutation}',childPanel=panel.querySelector('[ng-repeat="child in group.Children"]');
                if(mutation==='panel')panel.replaceWith(panel.cloneNode(true));
                if(mutation==='heading')panel.firstElementChild.replaceWith(panel.firstElementChild.cloneNode(true));
                if(mutation==='count'){const count=panel.querySelector('.pull-right.ng-binding');count.replaceWith(count.cloneNode(true));}
                if(mutation==='root'){const root=panel.closest('[ts-ack-group]');root.replaceWith(root.cloneNode(true));}
                if(mutation==='child')childPanel.replaceWith(childPanel.cloneNode(true));
                if(mutation==='child-heading')childPanel.firstElementChild.replaceWith(childPanel.firstElementChild.cloneNode(true));
                if(mutation==='section')document.querySelector('[ts-ack-group="schedule.Groups.${opposite}"] .panel-group').append(panel);
                if(mutation==='snapshot')window.dispatchEvent(new Event('bh-expanded-new-snapshot'));
                if(mutation==='disable')window.dispatchEvent(new Event('bh-expanded-disable'));
                if(mutation==='parent-scope'){
                  const replacement=JSON.parse(JSON.stringify(fixtureGroups[entry.section][0]));
                  fixtureGroups[entry.section][0]=replacement;fixtureScopes.set(panel,{group:replacement});
                }
                if(mutation==='child-scope')fixtureScopes.set(childPanel,{child:JSON.parse(JSON.stringify(fixtureGroups[entry.section][0].Children[0]))});
                if(mutation==='child-state')fixtureGroups[entry.section][0].Children[0].State={...fixtureGroups[entry.section][0].Children[0].State};
                if(mutation==='child-key')fixtureGroups[entry.section][0].Children[0].AlertKey='synthetic.changed{instance=race}';
              };
            })()`);
            const race=await run(`(() => {
              __BosunHelperBrowserTest.singleAlertAge.refresh();
              return {writes:expandedRaceWrites.slice(),text:expandedOldCount.textContent};
            })()`);
            if(mutation==='snapshot') {
              // Вложенный запрос MAIN отклоняется, пока выполняется внешнее чтение.
              assert.ok(race.writes.every(value=>/^\d+ alerts$/.test(value)),'A stale generation must never write age');
              assert.strictEqual(await run(`(() => {__BosunHelperBrowserTest.singleAlertAge.refresh();return expandedOldCount.textContent;})()`),'2m-ago');
            }
            else if(['parent-scope','child-scope','child-state','child-key'].includes(mutation))assert.ok(race.writes.every(value=>/^\d+ alerts$/.test(value)),mutation+': model race must fail closed');
            else if(mutation==='disable')assert.ok(race.writes.every(value=>/^\d+ alerts$/.test(value)));
            else assert.deepStrictEqual(race.writes,[],mutation+': stale DOM must not receive a write');
            negativeCases++;
          }
        }
        // Отсутствие СОБСТВЕННОЙ дочерней привязки — подтверждённое ограничение синтетического сценария,
        // а не доказанная причина в LIVE. Явно включаемый падающий тест остаётся отдельным.
        await prepareExpanded('Acknowledged');
        await mutateMain(`(() => {
          const entry=fixtureBodies.find(row=>row.section==='Acknowledged');
          fixtureScopes.set(entry.panel.querySelector('[ng-repeat="child in group.Children"]'),Object.create({child:fixtureGroups.Acknowledged[0].Children[0]}));
        })()`);
        const inherited=await run(`(() => {
          const hooks=__BosunHelperBrowserTest,api=hooks.singleAlertAge,diag=api.diagnostics;
          const panel=document.querySelector('[ts-ack-group="schedule.Groups.Acknowledged"] .panel-group > .panel');
          const originalFetch=globalThis.fetch;let requests=0;
          globalThis.fetch=()=>{requests++;throw Error('Unexpected synthetic request');};
          try {
            diag.start();for(let i=0;i<2050;i++)api.refresh();
            const report=diag.report();
            return {text:panel.querySelector('.pull-right.ng-binding').textContent,
              code:Object.values(report.panels).find(row=>row.section==='Acknowledged').expandedReaderReason,
              failures:report.totals.expandedReaderReasons['child-binding-inherited-parent'],
              fallbacks:report.totals.modelFallbacks,refreshes:report.totals.refreshes,requests,
              dropped:report.droppedEvents,events:report.events.length};
          } finally {diag.clear();globalThis.fetch=originalFetch;}
        })()`);
        assert.strictEqual(inherited.code,'child-binding-inherited-parent');assert.strictEqual(inherited.text,'1 alerts');
        assert.strictEqual(inherited.failures,2050,'Aggregated reasons must survive event eviction');
        assert.strictEqual(inherited.fallbacks,2050);assert.strictEqual(inherited.refreshes,2050);assert.strictEqual(inherited.requests,0);
        assert.ok(inherited.dropped>0);assert.strictEqual(inherited.events,2000);
        assert.strictEqual(await run(`BosunHelperGroupIdentity.expandedReaderReasonCode('PRIVATE_SENTINEL_NEVER_EXPORT')`),'unknown');
        if(process.argv.includes('--single-alert-age-inherited-child-regression'))assert.strictEqual(inherited.text,'6m-ago',
          'Candidate FAIL-BEFORE: inherited binding points to the exact parent child but the OWN-property reader rejects it; LIVE cause unproven');
        await mutateMain('resetAgeFixture();');
        await run(`(() => {
          const hooks=__BosunHelperBrowserTest;
          hooks.applyAlertsPayload(expandPayload,{source:'follower'});
          globalThis.expandRefreshes=0;globalThis.expandRequests=0;
          globalThis.expandOriginalRefresh=hooks.singleAlertAge.refresh;globalThis.expandOriginalFetch=globalThis.fetch;
          hooks.singleAlertAge.refresh=(...args)=>{expandRefreshes++;return expandOriginalRefresh(...args);};
          globalThis.fetch=()=>{expandRequests++;throw Error('Unexpected synthetic request');};
          hooks.startObserver();hooks.resetLifecycleCounters();hooks.singleAlertAge.diagnostics.start();
        })()`);
        let observation;
        try {
          await run('new Promise(resolve=>setTimeout(resolve,180))');
          await mutateMain(`(() => {
            const entry=fixtureBodies.find(row=>row.section==='Acknowledged'),child=fixtureGroups.Acknowledged[0].Children[0];
            const body=document.createElement('div');body.className='panel-body panel-group';
            body.innerHTML='<div class="panel" ng-repeat="child in group.Children"><div class="panel-heading">'+
              '<span ng-show="state.Id"></span><span ng-bind="child.Subject || child.AlertKey"></span></div></div>';
            body.querySelector('[ng-show="state.Id"]').textContent='#'+child.State.Id;
            body.querySelector('[ng-bind="child.Subject || child.AlertKey"]').textContent=child.Subject;
            fixtureScopes.set(body.firstElementChild,{child});entry.panel.append(body);
          })()`);
          observation=await run(`(async()=>{
            const hooks=__BosunHelperBrowserTest,settle=()=>new Promise(resolve=>setTimeout(resolve,180));
            const panel=document.querySelector('[ts-ack-group="schedule.Groups.Acknowledged"] .panel-group > .panel');
            await settle();const expanded=panel.querySelector('.pull-right.ng-binding').textContent;
            panel.querySelector('.panel-body').remove();await settle();
            const recollapsed=panel.querySelector('.pull-right.ng-binding').textContent,after=expandRefreshes;
            await settle();await settle();
            return {expanded,recollapsed,refreshes:after,idleRefreshes:expandRefreshes-after,
              requests:expandRequests,dataRefreshes:hooks.getLifecycleCounters().dataRefreshes};
          })()`);
        } finally {
          await run(`(() => {
            const hooks=__BosunHelperBrowserTest;
            hooks.singleAlertAge.refresh=expandOriginalRefresh;globalThis.fetch=expandOriginalFetch;
            hooks.singleAlertAge.diagnostics.clear();
            hooks.setFeature('singleAlertAge',false);
          })()`);
        }
        assert.strictEqual(observation.recollapsed,'6m-ago');
        assert.ok(observation.refreshes>0&&observation.refreshes<10);
        assert.strictEqual(observation.idleRefreshes,0,'Expand/collapse must not sustain an observer loop');
        assert.strictEqual(observation.requests,0);assert.strictEqual(observation.dataRefreshes,0);
        console.log('Expanded singleton identity regressions passed ('+(negativeCases+8)+' negative cases in both sections)');
        console.log('Scoped observer: bounded repaint, no idle loop, no API requests');
        for(const result of results.filter(row=>row.conflict==='none'))assert.strictEqual(result.expanded,'6m-ago',
          'A proven singleton with only a revised group Subject must retain age on expansion');
        assert.strictEqual(observation.expanded,'6m-ago','The observer path must retain the same confirmed snapshot age');
        return;
      }
      if (emptySectionRegressionOnly) {
        const results=[];
        for(const section of ['NeedAck','Acknowledged']) for(const shape of ['omitted','null','array']) {
          const opposite=section==='NeedAck'?'Acknowledged':'NeedAck';
          await mutateMain(`(() => {
            for(const type of ['NeedAck','Acknowledged'])if(!document.querySelector('[ts-ack-group="schedule.Groups.'+type+'"]')){
              const root=document.createElement('div');root.setAttribute('ts-ack-group','schedule.Groups.'+type);
              root.innerHTML='<div class="panel-group"></div>';document.body.append(root);
            }
            resetAgeFixture();document.querySelector('[ts-ack-group="schedule.Groups.${opposite}"]').remove();fixtureGroups.${opposite}=[];
          })();`);
          const result = await run(`(() => {
          const section=${JSON.stringify(section)},opposite=${JSON.stringify(opposite)},shape=${JSON.stringify(shape)};
          const hooks=__BosunHelperBrowserTest,diag=hooks.singleAlertAge.diagnostics;
          const panel=document.querySelector('[ts-ack-group="schedule.Groups.'+section+'"] .panel-group > .panel');
          const count=()=>panel.querySelector('.pull-right.ng-binding').textContent;
            diag.clear();
            const initial=JSON.parse(JSON.stringify(fixturePayload));
            if(shape==='omitted')delete initial.Groups[opposite];else initial.Groups[opposite]=shape==='null'?null:[];
            initial.Groups[section][0].Children[0].Ago=new Date(Date.now()-14*60000).toISOString();
            hooks.applyAlertsPayload(initial,{source:'leader'});diag.start();
            const before=count(),next=JSON.parse(JSON.stringify(initial));
            next.Groups[section][0].Subject='synthetic empty-section subject changed';
            const beforeApply=JSON.stringify(next);
            hooks.applyAlertsPayload(next,{source:'leader'});
            const first=count(),report=diag.report(),row=Object.values(report.panels)[0];
            const comparison=report.events.find(event=>event.event==='snapshot-index-comparison');
            const child=next.Groups[section][0].Children[0],identity=BosunHelperGroupIdentity.read(panel);
            const current=BosunHelperGroupIdentity.buildSnapshotIndexes(next,hooks.buildGroupMarkerKeyFromData)[section].get(String(child.State.Id));
            for(let i=0;i<2;i++)hooks.applyAlertsPayload(next,{source:'leader'});
            const snapshotUnchanged=beforeApply===JSON.stringify(next);
            globalThis.emptySectionPayload=JSON.parse(JSON.stringify(next));
            emptySectionPayload.Groups[section][0].Children[0].Ago=new Date(Date.now()-5*60000).toISOString();
            hooks.applyAlertsPayload(emptySectionPayload,{source:'leader'});
            const result={section,shape,before,first,updated:count(),snapshotUnchanged,readerVerified:identity?.section===section&&identity.children.length===1&&
              identity.children[0].id===String(child.State.Id)&&identity.children[0].key===child.AlertKey,
              sharedIndexHasCandidate:Boolean(current),fallbackAttempted:row.fallbackAttempted,fallbackReaderCalled:row.fallbackReaderCalled,
              fallbackReaderReason:row.fallbackReaderReason,fallbackReason:row.fallbackReason,modelIndexReason:row.modelIndexReason,
              restoreCountApplied:row.restoreCountApplied,graceSnapshotLimitExceeded:row.graceSnapshotLimitExceeded,
              graceTimeLimitExceeded:row.graceTimeLimitExceeded,stableChildFound:comparison.stableChildFoundInNewSnapshot,
              stableChildMatchCount:comparison.stableChildMatchCount,stableChildAgoChanged:comparison.stableChildAgoChanged,
              stableChildComparisonComplete:comparison.stableChildComparisonComplete};
            return result;
        })()`);
          await mutateMain(`(() => {
            const entry=fixtureBodies.find(row=>row.section===${JSON.stringify(section)});
            fixtureGroups[entry.section][0].Subject='synthetic empty-section subject changed';
            entry.panel.querySelector('[ng-bind="group.Subject"]').textContent='synthetic empty-section subject changed';
            const body=document.createElement('div');body.className='panel';body.setAttribute('ng-repeat','child in group.Children');
            body.innerHTML='<div class="panel-heading"><span ng-show="state.Id"></span><span ts-since="child.Ago">42m-ago</span></div>'+
              '<span ts-time="state.last.Time">synthetic older state</span>';
            body.querySelector('[ng-show="state.Id"]').textContent='#'+fixtureGroups[entry.section][0].Children[0].State.Id;
            entry.panel.append(body);
          })()`);
          Object.assign(result,await run(`(() => {
            const api=__BosunHelperBrowserTest.singleAlertAge,diag=api.diagnostics;
            const panel=document.querySelector('[ts-ack-group="schedule.Groups.${section}"] .panel-group > .panel');
            const count=()=>panel.querySelector('.pull-right.ng-binding').textContent;
            api.refresh();const expanded=count(),native=panel.querySelector('[ts-since="child.Ago"]').textContent;
            const since=panel.querySelector('[ts-time="state.last.Time"]').textContent;
            panel.querySelector('[ng-repeat="child in group.Children"]').remove();api.refresh();
            const report=diag.report();diag.clear();
            return {expanded,native,since,recollapsed:count(),restores:report.totals.restoreCountApplied,
              sources:report.events.filter(row=>row.event==='panel-decision'&&row.state==='age'&&row.repaintAttempted).map(row=>row.ageSource)};
          })()`));
          results.push(result);
        }
        for(const result of results){
          assert.strictEqual(result.before,'14m-ago');assert.strictEqual(result.readerVerified,true);
          assert.strictEqual(result.sharedIndexHasCandidate,true);assert.strictEqual(result.fallbackAttempted,true);
          assert.strictEqual(result.fallbackReaderCalled,true);assert.strictEqual(result.fallbackReaderReason,'reader-returned');
          assert.strictEqual(result.fallbackReason,'matched');
          assert.strictEqual(result.modelIndexReason,'ready');
          assert.strictEqual(result.restoreCountApplied,false);assert.strictEqual(result.graceSnapshotLimitExceeded,false);
          assert.strictEqual(result.graceTimeLimitExceeded,false);assert.strictEqual(result.stableChildFound,true);
          assert.strictEqual(result.stableChildMatchCount,1);assert.strictEqual(result.stableChildAgoChanged,false);
          assert.strictEqual(result.stableChildComparisonComplete,result.shape==='array');
          assert.strictEqual(result.snapshotUnchanged,true);
          assert.strictEqual(result.updated,'5m-ago');assert.strictEqual(result.expanded,'5m-ago');assert.strictEqual(result.recollapsed,'5m-ago');
          assert.strictEqual(result.native,'42m-ago');assert.strictEqual(result.since,'synthetic older state');
          assert.strictEqual(result.restores,0);assert.ok(result.sources.every(source=>source==='snapshot-child'));
        }
        console.log('Empty-section fallback and combined age-source regressions passed ('+results.length+' synthetic cases)');
        for(const result of results)assert.strictEqual(result.first,'14m-ago',
          'A valid empty opposite section must not reject a reader-verified singleton snapshot record');
        return;
      }
      if (ageSourceRegressionOnly) {
        const results = [];
        for (const section of ['NeedAck', 'Acknowledged']) {
          for (const matching of ['unique-subject', 'model-fallback']) for (const revision of ['aligned','older']) {
            await mutateMain(`resetAgeFixture();
              fixtureGroups[${JSON.stringify(section)}][0].Children[0].Ago=${JSON.stringify(revision==='aligned'?'2031-02-03T11:59:49Z':'2031-02-03T11:52:00Z')};
              fixtureGroups[${JSON.stringify(section)}][0].Children[0].State.Events=[{Status:'warning',Time:fixtureGroups[${JSON.stringify(section)}][0].Children[0].Ago}];`);
            const prepare = await run(`(() => {
              const section=${JSON.stringify(section)},matching=${JSON.stringify(matching)},hooks=__BosunHelperBrowserTest;
              const initial=JSON.parse(JSON.stringify(fixturePayload));
              for(const type of ['NeedAck','Acknowledged']){
                initial.Groups[type][0].Children[0].Ago=new Date(ageSourceClock-11*1000).toISOString();
                initial.Groups[type][0].Ago=new Date(ageSourceClock-86400000).toISOString();
              }
              const child=initial.Groups[section][0].Children[0];
              child.State.Start=new Date(ageSourceClock-86400000).toISOString();
              child.State.Events=[{Status:'warning',Time:new Date(ageSourceClock-8*60000).toISOString()},
                {Status:'critical',Time:child.Ago}];
              child.State.CurrentStatus='critical';
              if(matching==='model-fallback')initial.Groups[section][0].Subject='synthetic source changed';
              globalThis.sourcePanel=document.querySelector('[ts-ack-group="schedule.Groups.'+section+'"] .panel-group > .panel');
              globalThis.sourceCount=sourcePanel.querySelector('.pull-right.ng-binding');
              hooks.singleAlertAge.diagnostics.start();hooks.applyAlertsPayload(initial,{source:'follower'});
              globalThis.sourcePayload=initial;
              const identity=BosunHelperGroupIdentity.read(sourcePanel);
              return {collapsed:sourceCount.textContent,modelVerified:identity.section===section&&identity.children.length===1&&
                identity.children[0].id===String(child.State.Id)&&identity.children[0].key===child.AlertKey};
            })()`);
            await mutateMain(`(() => {
              const section=${JSON.stringify(section)},entry=fixtureBodies.find(row=>row.section===section);
              if(${JSON.stringify(matching)}==='model-fallback'){
                fixtureGroups[section][0].Subject='synthetic source changed';
                entry.panel.querySelector('[ng-bind="group.Subject"]').textContent='synthetic source changed';
              }
              const child=fixtureGroups[section][0].Children[0],body=document.createElement('div');
              body.className='panel';body.setAttribute('ng-repeat','child in group.Children');
              body.innerHTML='<div class="panel-heading"><span ng-show="state.Id"></span>'+
                '<span ng-bind="child.Subject || child.AlertKey"></span><span ts-since="child.Ago">${revision==='aligned'?'11s-ago':'8m-ago'}</span></div>';
              body.querySelector('[ng-show="state.Id"]').textContent='#'+child.State.Id;
              body.querySelector('[ng-bind="child.Subject || child.AlertKey"]').textContent=child.Subject;
              entry.panel.append(body);
            })()`);
            const result = await run(`(() => {
              const hooks=__BosunHelperBrowserTest,clockBefore=ageSourceClock;
              hooks.singleAlertAge.refresh();const expanded=sourceCount.textContent;
              const native=sourcePanel.querySelector('[ts-since="child.Ago"]').textContent;
              const nativeChild=sourcePanel.querySelector('[ng-repeat="child in group.Children"]');nativeChild.remove();
              hooks.singleAlertAge.refresh();const recollapsed=sourceCount.textContent;
              const updatedPayload=JSON.parse(JSON.stringify(sourcePayload));
              const child=updatedPayload.Groups[${JSON.stringify(section)}][0].Children[0];
              child.Ago=new Date(ageSourceClock-3*1000).toISOString();
              child.State.Events.push({Status:'warning',Time:child.Ago});child.State.CurrentStatus='warning';
              hooks.applyAlertsPayload(updatedPayload,{source:'follower'});const updatedCollapsed=sourceCount.textContent;
              sourcePanel.append(nativeChild);hooks.singleAlertAge.refresh();const updatedExpanded=sourceCount.textContent;
              const invalid=[];
              for(const value of ['',null,'invalid',new Date(ageSourceClock+60000).toISOString()]){
                const bad=JSON.parse(JSON.stringify(updatedPayload));bad.Groups[${JSON.stringify(section)}][0].Children[0].Ago=value;
                hooks.applyAlertsPayload(bad,{source:'follower'});invalid.push(sourceCount.textContent);
              }
              hooks.applyAlertsPayload(updatedPayload,{source:'follower'});const recovered=sourceCount.textContent;
              const nativeUnchanged=sourcePanel.querySelector('[ts-since="child.Ago"]').textContent===native;
              const report=hooks.singleAlertAge.diagnostics.report();hooks.singleAlertAge.diagnostics.clear();
              return {expanded,native,recollapsed,updatedCollapsed,updatedExpanded,invalid,recovered,nativeUnchanged,clockUnchanged:clockBefore===ageSourceClock,
                sameCount:sourceCount===sourcePanel.querySelector('.pull-right.ng-binding'),
                decisions:report.events.filter(row=>row.event==='panel-decision'&&row.section===${JSON.stringify(section)}).map(row=>({identityReason:row.identityReason,
                  presentationReason:row.presentationReason,modelIdentityMatched:row.modelIdentityMatched,state:row.state,
                  ageSource:row.ageSource,renderedAgeTextEqualsSnapshot:row.renderedAgeTextEqualsSnapshot,
                  snapshotChildAgoMatchesLastEvent:row.snapshotChildAgoMatchesLastEvent,
                  snapshotChildAgoMatchesIncidentStart:row.snapshotChildAgoMatchesIncidentStart}))};
            })()`);
            results.push({section,matching,revision,...prepare,...result});
          }
        }
        for(const result of results){
          assert.strictEqual(result.collapsed,'11s-ago');assert.strictEqual(result.recollapsed,'11s-ago');
          assert.strictEqual(result.native,result.revision==='aligned'?'11s-ago':'8m-ago');assert.strictEqual(result.modelVerified,true);
          assert.strictEqual(result.clockUnchanged&&result.sameCount,true);
          assert.ok(result.decisions.some(row=>row.identityReason==='group-key'&&row.state==='age'));
          assert.ok(result.decisions.some(row=>row.ageSource==='snapshot-child'&&row.identityReason==='group-key'&&
            row.renderedAgeTextEqualsSnapshot===(result.revision==='aligned')&&row.snapshotChildAgoMatchesLastEvent));
          assert.ok(result.decisions.every(row=>row.ageSource!=='rendered-child'));
          assert.ok(result.decisions.some(row=>row.ageSource==='snapshot-child'&&row.snapshotChildAgoMatchesLastEvent&&!row.snapshotChildAgoMatchesIncidentStart));
          if(result.matching==='model-fallback')assert.ok(result.decisions.some(row=>row.modelIdentityMatched));
          else assert.ok(result.decisions.some(row=>row.identityReason==='unique-subject'));
          assert.strictEqual(result.updatedCollapsed,'3s-ago');assert.strictEqual(result.updatedExpanded,'3s-ago');
          assert.ok(result.invalid.every(text=>text==='1 alerts'),'Invalid Ago must not borrow native DOM age');
          assert.strictEqual(result.recovered,'3s-ago');assert.strictEqual(result.nativeUnchanged,true);
        }
        console.log('Unified snapshot age-source regressions passed ('+results.length+' synthetic cases)');
        for(const result of results)assert.strictEqual(result.expanded,result.collapsed,
          'Expansion alone must not replace the confirmed snapshot event age with stale native child text');
        return;
      }
      const results = await run(`(() => {
        const hooks = __BosunHelperBrowserTest, diagnostic = hooks.singleAlertAge.diagnostics;
        const roots = ['NeedAck', 'Acknowledged'];
        const initial = JSON.parse(JSON.stringify(fixturePayload));
        for (const section of roots) initial.Groups[section][0].Children[0].Ago = new Date(Date.now() - 14 * 60000).toISOString();
        const result = [];
        for (const section of roots) {
          diagnostic.clear(); hooks.applyAlertsPayload(initial, { source: 'follower' }); diagnostic.start();
          const panel = document.querySelector('[ts-ack-group="schedule.Groups.' + section + '"] .panel-group > .panel');
          const heading = panel.querySelector(':scope > .panel-heading');
          const node = heading.querySelector('.pull-right.ng-binding');
          const before = node.textContent;
          const markersBefore = JSON.stringify(fixtureState());
          const changed = JSON.parse(JSON.stringify(initial));
          changed.Groups[section][0].Subject = 'synthetic subject updated';
          changed.Groups[section][0].Children[0].Subject = 'synthetic subject updated';
          changed.Groups[section][0].Children[0].Ago = new Date(Date.now() - 5 * 60000).toISOString();
          // Keep the native scope and collapsed DOM at the original Subject.
          for (let generation = 0; generation < 3; generation += 1) {
            changed.Groups[section][0].Subject = 'synthetic subject updated ' + generation;
            hooks.applyAlertsPayload(changed, { source: 'follower' });
          }
          const identity = BosunHelperGroupIdentity.read(panel);
          const expected = changed.Groups[section][0].Children[0];
          const allChildren = roots.flatMap(value => changed.Groups[value].flatMap(group => group.Children));
          const verified = identity?.section === section && identity.children.length === 1 &&
            identity.children[0].id === String(expected.State.Id) && identity.children[0].key === expected.AlertKey &&
            allChildren.filter(child => child.State.Id === expected.State.Id).length === 1 &&
            allChildren.filter(child => child.AlertKey === expected.AlertKey).length === 1;
          const report = diagnostic.report();
          const row = Object.values(report.panels).find(row => row.section === section);
          const other = roots.find(value => value !== section);
          result.push({ before, after: node.textContent, verified,
            markersUnchanged: markersBefore === JSON.stringify(fixtureState()),
            modelIdentityMatched: row.modelIdentityMatched, presentationReason: row.presentationReason,
            samePanel: panel === document.querySelector('[ts-ack-group="schedule.Groups.' + section + '"] .panel-group > .panel'),
            sameHeading: heading === panel.querySelector(':scope > .panel-heading'),
            collapsed: panel.querySelectorAll('[ng-repeat="child in group.Children"]').length === 0,
            reason: row.identityReason, graceSnapshotLimitExceeded: row.graceSnapshotLimitExceeded,
            timeLimitExceeded: row.graceTimeLimitExceeded,
            restored: report.events.some(event => event.section === section && event.restoreCountApplied === true),
            control: document.querySelector('[ts-ack-group="schedule.Groups.' + other + '"] .pull-right.ng-binding').textContent });
          diagnostic.stop();
        }
        diagnostic.clear(); return result;
      })()`);
      for (const result of results) {
        assert.strictEqual(result.before, '14m-ago');
        assert.strictEqual(result.verified, true, 'Real guarded reader must prove the current panel ID + AlertKey');
        assert.strictEqual(result.samePanel && result.sameHeading && result.collapsed, true);
        assert.strictEqual(result.control, '14m-ago');
        assert.strictEqual(result.markersUnchanged, true, 'Age fallback must preserve Priority/Note');
        assert.strictEqual(result.modelIdentityMatched, true);
        assert.strictEqual(result.presentationReason, 'model-identity-match');
      }
      console.log('Subject-change regression (synthetic):', JSON.stringify(results));
      for (const result of results) assert.strictEqual(result.after, '5m-ago',
        'Verified current panel model and unique current snapshot child must survive Subject changes beyond grace');
      for (const scenario of ['id', 'key', 'duplicate-id', 'duplicate-key', 'cross-id', 'cross-key', 'multiple',
        'missing-id', 'incomplete', 'conflicting-key', 'target-subject-duplicate', 'duplicate-subject', 'strong-key-mismatch',
        'duplicate-group-key', 'unavailable', 'throw', 'promise-reject', 'promise-resolve', 'rejected', 'section-moved',
        'missing-age', 'future-age', 'model-multiple', 'invalid-model','invalid-section','children-object','empty-children']) {
        await mutateMain('resetAgeFixture();');
        if(scenario==='model-multiple')await mutateMain(`fixtureGroups.NeedAck[0].Children.push({State:{Id:9730},AlertKey:'synthetic.extra{instance=model}'});`);
        const negative = await run(`(async () => {
          const scenario = ${JSON.stringify(scenario)}, hooks = __BosunHelperBrowserTest;
          const originalRead = BosunHelperGroupIdentity.read;
          const originalRefresh = hooks.singleAlertAge.refresh;
          let ageReading = false;
          hooks.singleAlertAge.refresh = (...args) => { ageReading=true;try{return originalRefresh(...args);}finally{ageReading=false;} };
          let reads = 0, requests = 0;
          const originalFetch = globalThis.fetch;
          globalThis.fetch = () => { requests++; throw Error('Unexpected synthetic request'); };
          const initial = JSON.parse(JSON.stringify(fixturePayload));
          for (const section of ['NeedAck','Acknowledged']) initial.Groups[section][0].Children[0].Ago = new Date(Date.now()-14*60000).toISOString();
          hooks.applyAlertsPayload(initial,{source:'follower'});
          const panel = document.querySelector('[ts-ack-group="schedule.Groups.NeedAck"] .panel-group > .panel');
          const diagnostic=hooks.singleAlertAge.diagnostics;diagnostic.start();
          const count = () => panel.querySelector('.pull-right.ng-binding').textContent;
          const next = JSON.parse(JSON.stringify(initial)), group = next.Groups.NeedAck[0], child = group.Children[0];
          group.Subject = 'synthetic subject updated'; child.Ago = new Date(Date.now()-5*60000).toISOString();
          const extra = JSON.parse(JSON.stringify(group)); extra.Subject = 'synthetic extra group';
          extra.Children[0].State.Id = 9711; extra.Children[0].AlertKey = 'synthetic.extra{instance=other}';
          if(scenario==='id')child.State.Id=9712;
          if(scenario==='key')child.AlertKey='synthetic.other{instance=other}';
          if(scenario==='duplicate-id'||scenario==='cross-id')extra.Children[0].State.Id=child.State.Id;
          if(scenario==='duplicate-key'||scenario==='cross-key')extra.Children[0].AlertKey=child.AlertKey;
          if(scenario.startsWith('duplicate-')&&scenario!=='duplicate-subject'&&scenario!=='duplicate-group-key')next.Groups.NeedAck.push(extra);
          if(scenario.startsWith('cross-'))next.Groups.Acknowledged.push(extra);
          if(scenario==='multiple')group.Children.push(extra.Children[0]);
          if(scenario==='missing-id')delete child.State.Id;
          if(scenario==='missing-age')child.Ago='';
          if(scenario==='future-age')child.Ago=new Date(Date.now()+60000).toISOString();
          if(scenario==='incomplete')delete group.Children;
          if(scenario==='invalid-section')next.Groups.Acknowledged={invalid:true};
          if(scenario==='children-object')group.Children={...child};
          if(scenario==='empty-children')group.Children=[];
          if(scenario==='conflicting-key')child.State.AlertKey='synthetic.conflict{instance=other}';
          if(scenario==='section-moved'){next.Groups.NeedAck=[];next.Groups.Acknowledged.push(group);}
          if(scenario==='target-subject-duplicate'){extra.Subject=group.Subject;next.Groups.NeedAck.push(extra);}
          if(scenario==='duplicate-subject'){group.Subject=initial.Groups.NeedAck[0].Subject;extra.Subject=group.Subject;next.Groups.NeedAck.push(extra);}
          if(scenario==='strong-key-mismatch'||scenario==='duplicate-group-key'){
            const visible=document.createElement('div');visible.className='panel';visible.setAttribute('ng-repeat','child in group.Children');
            visible.innerHTML='<div class="panel-heading"><span ng-show="state.Id">#9601</span></div>';panel.append(visible);
            if(scenario==='duplicate-group-key'){group.Subject=initial.Groups.NeedAck[0].Subject;next.Groups.NeedAck.push(JSON.parse(JSON.stringify(group)));}
          }
          BosunHelperGroupIdentity.read = node => {
            if(!ageReading)return originalRead(node);
            reads++;
            if(scenario==='unavailable')return null;
            if(scenario==='throw')throw Error('Synthetic unavailable reader');
            if(scenario==='promise-reject')return Promise.reject(Error('Synthetic async failure'));
            if(scenario==='promise-resolve')return Promise.resolve(originalRead(node));
            if(scenario==='rejected')return {rejected:true};
            if(scenario==='invalid-model')return {section:'NeedAck',children:[{}]};
            return originalRead(node);
          };
          let first;
          try {
            for(let i=0;i<4;i++){hooks.applyAlertsPayload(next,{source:'follower'});if(i===0)first=count();}
            await Promise.resolve(); await Promise.resolve();
            const report=diagnostic.report(),row=Object.values(report.panels).find(row=>row.section==='NeedAck');
            const serialized=JSON.stringify(report);
            for(const forbidden of ['synthetic.angular','synthetic.extra','9601','9712'])if(serialized.includes(forbidden))throw Error('Diagnostic privacy regression');
            return {first, final:count(), requests, reads,fallbackReason:row.fallbackReason,readerReason:row.fallbackReaderReason,
              fallbackAttempted:row.fallbackAttempted,readerCalled:row.fallbackReaderCalled,indexReason:row.modelIndexReason};
          } finally {diagnostic.clear();BosunHelperGroupIdentity.read=originalRead;hooks.singleAlertAge.refresh=originalRefresh;globalThis.fetch=originalFetch;}
        })()`);
        assert.notStrictEqual(negative.first, '5m-ago', scenario + ': unsafe current age must never appear');
        if (!['unavailable','throw','promise-reject','promise-resolve'].includes(scenario))
          assert.strictEqual(negative.first, '1 alerts', scenario + ': explicit conflict must not preserve cached age');
        if (['strong-key-mismatch','duplicate-subject','duplicate-group-key'].includes(scenario))
          assert.strictEqual(negative.reads, 0, scenario + ': must never invoke model fallback');
        assert.strictEqual(negative.final, '1 alerts', scenario + ': unsafe identity must fail closed');
        assert.strictEqual(negative.requests, 0, scenario + ': must not fetch');
        const expectedReasons={id:'id-mismatch',key:'alertkey-mismatch','duplicate-id':'duplicate','duplicate-key':'duplicate',
          'cross-id':'duplicate','cross-key':'duplicate',multiple:'snapshot-child-count','model-multiple':'model-child-count',
          'missing-id':'index-unavailable',incomplete:'index-unavailable','conflicting-key':'index-unavailable',
          'target-subject-duplicate':'duplicate-or-unindexed',rejected:'reader-rejected','section-moved':'section-mismatch',
          unavailable:'unavailable',throw:'unavailable','promise-reject':'unavailable','promise-resolve':'unavailable',
          'duplicate-subject':'identity-ineligible','duplicate-group-key':'identity-ineligible','strong-key-mismatch':'reader-rejected',
          'missing-age':'matched','future-age':'matched','invalid-model':'invalid-model',
          'invalid-section':'index-unavailable','children-object':'index-unavailable','empty-children':'index-unavailable'};
        assert.strictEqual(negative.fallbackReason,expectedReasons[scenario],scenario+': precise safe fallback reason');
        if(['unavailable','throw','promise-reject','promise-resolve','rejected'].includes(scenario)){
          assert.strictEqual(negative.readerCalled,true);
          const reasons={unavailable:'reader-empty',throw:'reader-threw','promise-reject':'unexpected-promise','promise-resolve':'unexpected-promise',rejected:'reader-rejected'};
          assert.strictEqual(negative.readerReason,reasons[scenario]);
        }
      }
      // Обработчики мутаций выполняются в MAIN во время настоящего синхронного чтения, не до обновления.
      for (const mutation of ['panel', 'heading', 'count', 'root', 'section', 'snapshot']) {
        await mutateMain('resetAgeFixture();');
        await run(`(() => {
          const hooks=__BosunHelperBrowserTest;
          globalThis.ageInitial=JSON.parse(JSON.stringify(fixturePayload));
          for(const section of ['NeedAck','Acknowledged'])ageInitial.Groups[section][0].Children[0].Ago=new Date(Date.now()-14*60000).toISOString();
          hooks.applyAlertsPayload(ageInitial,{source:'follower'});
          const changed=JSON.parse(JSON.stringify(ageInitial));changed.Groups.NeedAck[0].Subject='synthetic changed';
          changed.Groups.NeedAck[0].Children[0].Ago=new Date(Date.now()-5*60000).toISOString();
          const read=BosunHelperGroupIdentity.read;BosunHelperGroupIdentity.read=()=>null;
          try{hooks.applyAlertsPayload(changed,{source:'follower'});}finally{BosunHelperGroupIdentity.read=read;}
          globalThis.ageOldCount=document.querySelector('[ts-ack-group="schedule.Groups.NeedAck"] .pull-right.ng-binding');
          globalThis.ageWrites=[];const descriptor=Object.getOwnPropertyDescriptor(Node.prototype,'textContent');
          Object.defineProperty(ageOldCount,'textContent',{configurable:true,get(){return descriptor.get.call(this);},
            set(value){ageWrites.push(value);descriptor.set.call(this,value);}});
          hooks.singleAlertAge.diagnostics.start();
          if(${JSON.stringify(mutation)}==='snapshot')window.addEventListener('bh-age-new-snapshot',()=>{
            const newest=JSON.parse(JSON.stringify(ageInitial));newest.Groups.NeedAck[0].Children[0].Ago=new Date(Date.now()-2*60000).toISOString();
            hooks.applyAlertsPayload(newest,{source:'follower'});
          },{once:true});
        })()`);
        await mutateMain(`beforeScopeRead = node => {
          const panel=fixtureBodies[0].panel;if(node!==panel)return;beforeScopeRead=null;
          const mutation=${JSON.stringify(mutation)};
          if(mutation==='panel')panel.replaceWith(panel.cloneNode(true));
          if(mutation==='heading')panel.firstElementChild.replaceWith(panel.firstElementChild.cloneNode(true));
          if(mutation==='count'){const count=panel.querySelector('.pull-right.ng-binding');count.replaceWith(count.cloneNode(true));}
          if(mutation==='root'){const root=panel.closest('[ts-ack-group]');root.replaceWith(root.cloneNode(true));}
          if(mutation==='section')document.querySelector('[ts-ack-group="schedule.Groups.Acknowledged"] .panel-group').append(panel);
          if(mutation==='snapshot')window.dispatchEvent(new Event('bh-age-new-snapshot'));
        };`);
        const guarded = await run(`(() => {const api=__BosunHelperBrowserTest.singleAlertAge;api.refresh();
          const stale=api.diagnostics.report().events.some(event=>event.event==='model-fallback'&&event.fallbackReason==='stale-state');
          api.diagnostics.clear();return {writes:ageWrites.slice(),text:ageOldCount.textContent,stale};})()`);
        assert.strictEqual(guarded.stale,true,mutation+': stale read must be observable without a write');
        if (mutation === 'snapshot') {
          assert.deepStrictEqual(guarded.writes, ['2m-ago'], 'Only the reentrant newest generation may write');
          assert.strictEqual(guarded.text, '2m-ago');
        } else assert.deepStrictEqual(guarded.writes, [], mutation + ': stale operation must not write');
      }
      await mutateMain('resetAgeFixture();');
      const observation = await run(`(async () => {
        const hooks=__BosunHelperBrowserTest, initial=JSON.parse(JSON.stringify(fixturePayload));
        for(const section of ['NeedAck','Acknowledged'])initial.Groups[section][0].Children[0].Ago=new Date(Date.now()-14*60000).toISOString();
        hooks.applyAlertsPayload(initial,{source:'follower'});
        const changed=JSON.parse(JSON.stringify(initial));changed.Groups.NeedAck[0].Subject='synthetic latest';
        changed.Groups.NeedAck[0].Children[0].Ago=new Date(Date.now()-5*60000).toISOString();
        hooks.applyAlertsPayload(changed,{source:'follower'});
        let refreshes=0,requests=0;
        const originalRefresh=hooks.singleAlertAge.refresh,originalFetch=globalThis.fetch;
        hooks.singleAlertAge.refresh=(...args)=>{refreshes++;return originalRefresh(...args);};
        globalThis.fetch=()=>{requests++;throw Error('Unexpected synthetic request');};
        const settle=()=>new Promise(resolve=>setTimeout(resolve,180));
        try {
          hooks.startObserver();await settle();refreshes=0;hooks.resetLifecycleCounters();
          const node=document.querySelector('[ts-ack-group="schedule.Groups.NeedAck"] .pull-right.ng-binding');
          for(let i=0;i<3;i++){node.firstChild.data='1 alerts';await settle();}
          const afterWrites=refreshes;await settle();await settle();
          const result={text:node.textContent,afterWrites,idle:refreshes-afterWrites,requests,counters:hooks.getLifecycleCounters()};
          hooks.setFeature('singleAlertAge',false);result.disabledText=node.textContent;
          result.historyEntries=hooks.singleAlertAge.getHistoryStats().entries;
          return result;
        } finally {hooks.singleAlertAge.refresh=originalRefresh;globalThis.fetch=originalFetch;}
      })()`);
      assert.strictEqual(observation.text, '5m-ago');
      assert.ok(observation.afterWrites >= 3 && observation.afterWrites <= 5);
      assert.strictEqual(observation.idle, 0, 'Model-backed age writes must not sustain an observer loop');
      assert.strictEqual(observation.requests, 0);
      assert.strictEqual(observation.counters.dataRefreshes, 0);
      assert.strictEqual(observation.disabledText, '1 alerts', 'Disable must clean up model-backed ages');
      assert.strictEqual(observation.historyEntries, 0);
      console.log('Subject-change negative identity and reentrant DOM/snapshot regressions passed');
      return;
    }
    await mutateMain('fixtureBodies.forEach(entry => entry.body.remove());');
    await run('__BosunHelperBrowserTest.runDomRefreshPass({ preserveExistingOnNone: true });');
    assert.ok((await run('fixtureState()')).every(row => row.children === 0 && row.priority && row.accent),
      'Angular identity: Subject mismatch + removed child DOM must retain collapsed parent Priority');
    for (let pass = 0; pass < 2; pass += 1) {
      await run('__BosunHelperBrowserTest.applyAlertsPayload(JSON.parse(JSON.stringify(fixturePayload)), { source: "follower" });');
      assert.ok((await run('fixtureState()')).every(row => row.priority));
      await mutateMain('fixtureBodies.forEach(entry => entry.panel.appendChild(entry.body));');
      await run('__BosunHelperBrowserTest.runDomRefreshPass({ preserveExistingOnNone: true });');
      assert.ok((await run('fixtureState()')).every(row => row.priority));
      assert.strictEqual((await run('fixtureState()'))[0].childNote, true);
      await mutateMain('fixtureBodies.forEach(entry => entry.body.remove());');
      await run('__BosunHelperBrowserTest.runDomRefreshPass({ preserveExistingOnNone: true });');
      assert.ok((await run('fixtureState()')).every(row => row.priority));
    }
    const refresh = () => run('__BosunHelperBrowserTest.runDomRefreshPass({ preserveExistingOnNone: true });');
    const ackPriority = async () => (await run('fixtureState()'))[1].priority;
    const applyBase = () => run('__BosunHelperBrowserTest.applyAlertsPayload(JSON.parse(JSON.stringify(fixturePayload)), { source: "follower" });');
    // Соседние свёрнутые группы с одним точным правилом должны сопоставляться раздельно,
    // при согласовании всех четырёх источников имени/ключа и допустимых именах тегов Bosun.
    await mutateMain(`
      siblingRoot=document.querySelector('[ts-ack-group="schedule.Groups.NeedAck"]');
      savedSiblingContainer=siblingRoot.firstElementChild;savedSiblingGroups=fixtureGroups.NeedAck;
      siblingContainer=document.createElement('div');siblingContainer.className='panel-group';
      siblingPanels=[];siblingBodies=[];fixtureGroups.NeedAck=[];
      for(let i=0;i<4;i++){
        const name=i===3?'synthetic.other':'synthetic.angular';
        const cluster=i===1?'two words':i===2?'three words':'one';
        const key=name+'{'+(i===1?'cloud.zone=synthetic,':'')+'cluster='+cluster+',instance=node'+i+(i===2?',rack/slot=synthetic':'')+'}';
        const child={AlertKey:key,Subject:'synthetic sibling '+i,Ago:'1m',
          State:{Id:9701+i,CurrentStatus:'critical',Actions:[{Type:'Note'}]}};
        child.Alert=name;child.State.Alert=name;child.State.AlertKey=key;
        const group={Subject:'synthetic sibling group '+i,Children:[child]};fixtureGroups.NeedAck.push(group);
        const panel=fixtureBodies[0].panel.cloneNode(true);
        panel.querySelector('[ng-bind="group.Subject"]').textContent=group.Subject;
        panel.querySelectorAll('.bosun-priority-marker').forEach(node=>node.remove());
        panel.querySelectorAll('.bosun-priority-row').forEach(node=>node.classList.remove('bosun-priority-row'));
        const body=fixtureBodies[0].body.cloneNode(true);
        body.querySelector('[ng-show="state.Id"]').textContent='#'+child.State.Id;
        body.querySelector('[ng-bind="child.Subject || child.AlertKey"]').textContent=child.Subject;
        panel.querySelector('.panel-body')?.remove();
        siblingPanels.push(panel);siblingBodies.push(body);fixtureScopes.set(panel,{group});siblingContainer.appendChild(panel);
      }
      savedSiblingContainer.replaceWith(siblingContainer);
    `);
    // Через границу теста передаются только синтетические данные API; рабочий мост
    // по-прежнему выдаёт идентичности, а не полученное от страницы состояние Priority.
    const siblingApiGroups = await mutateMain('JSON.parse(JSON.stringify(fixtureGroups.NeedAck))');
    await run(`globalThis.siblingPayload=JSON.parse(JSON.stringify(fixturePayload));
      siblingPayload.Groups.NeedAck=${JSON.stringify(siblingApiGroups)};
      __BosunHelperBrowserTest.applyAlertsPayload(siblingPayload,{source:'follower'});`);
    const assertSiblings = async label => {
      const state = await run('fixtureState()');
      assert.deepStrictEqual(state.slice(0,4).map(row=>row.priority),[true,true,true,false],label);
      assert.deepStrictEqual(state.slice(0,4).map(row=>row.accent),[true,true,true,false],label+' accent');
      assert.strictEqual(state[4].priority,true,label+' Acknowledged isolation');
    };
    await assertSiblings('Three initially collapsed instances covered by one exact rule');
    assert.ok((await run('fixtureState()')).slice(0,4).every(row=>row.parentNote),'Collapsed sibling Note markers remain present');
    assert.deepStrictEqual(await run(`Array.from(document.querySelectorAll('[ts-ack-group="schedule.Groups.NeedAck"] [ng-repeat="group in groups"]'))
      .map(panel=>BosunHelperGroupIdentity.read(panel)?.children.map(row=>row.id))`),
    [['9701'],['9702'],['9703'],['9704']], 'Bridge reads individual identities for every sibling');
    for(let pass=0;pass<2;pass++){
      for(let i=0;i<4;i++){
        await mutateMain(`siblingPanels[${i}].appendChild(siblingBodies[${i}]);`);await refresh();
        await assertSiblings('Expanded sibling '+i);
        assert.strictEqual((await run('fixtureState()'))[i].childNote,true,'Sibling Note survives expansion');
        await mutateMain(`siblingBodies[${i}].remove();`);await refresh();
        await assertSiblings('Collapsed sibling '+i);
      }
      await run('__BosunHelperBrowserTest.applyAlertsPayload(JSON.parse(JSON.stringify(siblingPayload)),{source:"follower"});');
      await assertSiblings('Repeated snapshot for same-name siblings');
      // Ни равенство Subject, ни порядок DOM/API не доказывают принадлежность.
      await mutateMain(`siblingPanels.forEach(panel=>panel.querySelector('[ng-bind="group.Subject"]').textContent='same native subject');
        siblingPanels.slice().reverse().forEach(panel=>siblingContainer.appendChild(panel));`);
      await refresh();
      const reversed = await run('fixtureState()');
      assert.deepStrictEqual(reversed.slice(0,4).map(row=>row.priority),[false,true,true,true],
        'Distinct group identities survive duplicate mismatching Subjects and reversed DOM order');
      await mutateMain('siblingPanels.forEach(panel=>siblingContainer.appendChild(panel));');await refresh();
      await assertSiblings('Restored DOM order has no effect on Priority');
    }
    // Отказ при неоднозначной идентичности затрагивает только соответствующие группы.
    for(const duplicate of ['id','key']){
      await mutateMain(duplicate==='id'
        ? 'fixtureGroups.NeedAck[1].Children[0].State.Id=9701;'
        : 'fixtureGroups.NeedAck[1].Children[0].AlertKey=fixtureGroups.NeedAck[1].Children[0].State.AlertKey=fixtureGroups.NeedAck[0].Children[0].AlertKey;');
      await run(`(()=>{const next=JSON.parse(JSON.stringify(siblingPayload));
        ${duplicate==='id' ? 'next.Groups.NeedAck[1].Children[0].State.Id=9701;' : 'next.Groups.NeedAck[1].Children[0].AlertKey=next.Groups.NeedAck[1].Children[0].State.AlertKey=next.Groups.NeedAck[0].Children[0].AlertKey;'}
        __BosunHelperBrowserTest.applyAlertsPayload(next,{source:'follower'});})()`);
      assert.deepStrictEqual((await run('fixtureState()')).slice(0,4).map(row=>row.priority),[false,false,true,false],
        'Duplicate '+duplicate+' fails closed without losing unrelated sibling Priority');
      await mutateMain('fixtureGroups.NeedAck[1].Children[0].State.Id=9702;fixtureGroups.NeedAck[1].Children[0].AlertKey=fixtureGroups.NeedAck[1].Children[0].State.AlertKey='+JSON.stringify(siblingApiGroups[1].Children[0].AlertKey)+';');
      await run('__BosunHelperBrowserTest.applyAlertsPayload(JSON.parse(JSON.stringify(siblingPayload)),{source:"follower"});');
      await assertSiblings('Sibling identity restored');
    }
    await run(`(()=>{const settings=JSON.parse(JSON.stringify(BosunHelperSettings.DEFAULTS));
      settings.features.priorityAlerts=true;settings.preferences.priorityCritical=false;settings.preferences.priorityShowAcknowledged=true;
      settings.priorityRules.exactAlertNames=[];
      __BosunHelperBrowserTest.applySettingsSnapshot(settings,{changedPaths:['priorityRules.exactAlertNames']});})()`);
    assert.ok((await run('fixtureState()')).every(row=>!row.priority&&!row.accent),'Removing exact rule removes all instance markers');
    await run('__BosunHelperBrowserTest.setPreference("priorityCritical",true);');
    assert.deepStrictEqual((await run('fixtureState()')).slice(0,4).map(row=>row.priority),[false,false,false,false],
      'Retired Critical preference must never assign Priority without an exact rule');
    assert.strictEqual((await run('fixtureState()'))[4].priority,false,'Warning Acknowledged group has no automatic Critical Priority');
    await run(`(()=>{const settings=JSON.parse(JSON.stringify(BosunHelperSettings.DEFAULTS));
      settings.features.priorityAlerts=true;settings.preferences.priorityCritical=false;settings.preferences.priorityShowAcknowledged=true;
      settings.priorityRules.exactAlertNames=['synthetic.angular'];
      __BosunHelperBrowserTest.applySettingsSnapshot(settings,{changedPaths:['priorityRules.exactAlertNames','preferences.priorityCritical']});})()`);
    await assertSiblings('Exact rule restored independently of automatic Critical Priority');
    await run('__BosunHelperBrowserTest.setPreference("priorityShowAcknowledged",false);');
    assert.deepStrictEqual((await run('fixtureState()')).map(row=>row.priority),[true,true,true,false,true],
      'Retired Acknowledged setting must not hide Priority in either section');
    await run('__BosunHelperBrowserTest.setPreference("priorityShowAcknowledged",true);');
    await assertSiblings('Acknowledged presentation restored');
    await mutateMain('siblingContainer.replaceWith(savedSiblingContainer);fixtureGroups.NeedAck=savedSiblingGroups;');
    await applyBase();
    // Полный состав не зависит от порядка; корректная свёрнутая группа с несколькими детьми
    // по-прежнему использует текущую классификацию API, а не предыдущий маркер.
    await mutateMain(`fixtureGroups.Acknowledged[0].Children.push({State:{Id:9604},AlertKey:'synthetic.second{}'});
      fixtureGroups.Acknowledged[0].Children.reverse();`);
    await run(`(() => {const next=JSON.parse(JSON.stringify(fixturePayload));
      next.Groups.Acknowledged[0].Children.push({Alert:'synthetic.normal',State:{Id:9604},AlertKey:'synthetic.second{}'});
      __BosunHelperBrowserTest.applyAlertsPayload(next,{source:'follower'});})()`);
    assert.strictEqual(await ackPriority(), true, 'Complete reordered multi-child model matches one API group');
    await mutateMain('fixtureGroups.Acknowledged[0].Children.reverse();fixtureGroups.Acknowledged[0].Children.pop();');
    await applyBase();
    // Каждое синхронное чтение должно удалять свой временный обработчик ответа.
    assert.strictEqual(await run(`(() => {
      const add=window.addEventListener,remove=window.removeEventListener;let balance=0;
      window.addEventListener=function(type,...args){if(type==='bosun-helper-group-identity-result-v1')balance++;return add.call(this,type,...args);};
      window.removeEventListener=function(type,...args){if(type==='bosun-helper-group-identity-result-v1')balance--;return remove.call(this,type,...args);};
      try {for(let i=0;i<5;i++)BosunHelperGroupIdentity.read(document.querySelector('[ng-repeat="group in groups"]'));return balance;}
      finally {window.addEventListener=add;window.removeEventListener=remove;}
    })()`), 0);
    // Неподдерживаемые или некорректные данные scope не создают идентичность.
    await mutateMain('savedAngular = angular; angular = null;'); await refresh();
    assert.strictEqual(await ackPriority(), false);
    await mutateMain('angular = savedAngular; savedChildren = fixtureGroups.Acknowledged[0].Children.slice(); fixtureGroups.Acknowledged[0].Children.push(savedChildren[0]);');
    await refresh(); assert.strictEqual(await ackPriority(), false);
    await mutateMain('fixtureGroups.Acknowledged[0].Children = savedChildren; fixtureGroups.Acknowledged.push({Children:savedChildren});');
    await refresh(); assert.strictEqual(await ackPriority(), false);
    await mutateMain('fixtureGroups.Acknowledged.length = 1; fixtureGroups.Acknowledged[0].Children[0].State.AlertKey = "synthetic.conflict{}";');
    await refresh(); assert.strictEqual(await ackPriority(), false);
    await mutateMain('delete fixtureGroups.Acknowledged[0].Children[0].State.AlertKey;');
    await applyBase(); assert.strictEqual(await ackPriority(), true);
    await mutateMain(`duplicatePanel=fixtureBodies[1].panel.cloneNode(true);fixtureBodies[1].panel.parentElement.appendChild(duplicatePanel);
      fixtureScopes.set(duplicatePanel,{group:fixtureGroups.Acknowledged[0]});`);
    await refresh(); assert.strictEqual(await ackPriority(), false);
    await mutateMain('duplicatePanel.remove();');
    await refresh(); assert.strictEqual(await ackPriority(), true);
    // Полный состав, дубликаты API, конфликты AlertKey и границы секций.
    for (const change of [
      'next.Groups.Acknowledged.push(JSON.parse(JSON.stringify(next.Groups.Acknowledged[0])));',
      'next.Groups.Acknowledged[0].Children.push({...next.Groups.Acknowledged[0].Children[0], State:{Id:9699}, AlertKey:"synthetic.extra{}"});',
      'next.Groups.Acknowledged[0].Children[0].State.AlertKey = "synthetic.conflict{}";',
      'next.Groups.NeedAck.push(next.Groups.Acknowledged[0]); next.Groups.Acknowledged = [];',
      'next.Groups.NeedAck.push(JSON.parse(JSON.stringify(next.Groups.Acknowledged[0])));',
      'next.Groups.Acknowledged[0].Children[0].State.Id = 9601;'
    ]) {
      await run(`(() => { const next = JSON.parse(JSON.stringify(fixturePayload)); ${change}
        __BosunHelperBrowserTest.applyAlertsPayload(next, { source: 'follower' }); })()`);
      assert.strictEqual(await ackPriority(), false, change);
      await applyBase(); assert.strictEqual(await ackPriority(), true);
    }
    await mutateMain('fixtureGroups.Acknowledged[0].Children = [...savedChildren, {State:{Id:9699},AlertKey:"synthetic.extra{}"}];');
    await refresh(); assert.strictEqual(await ackPriority(), false);
    await mutateMain('fixtureGroups.Acknowledged[0].Children = savedChildren;');
    await refresh(); assert.strictEqual(await ackPriority(), true);
    // Поддельный ответ содержит полностью корректную ДРУГУЮ группу из той же текущей
    // секции API. Одни проверки состава ошибочно добавили бы маркеры этой строке.
    await mutateMain(`
      fixtureGroups.Acknowledged[0].Children[0].AlertKey = 'synthetic.normal{}';
      fixtureGroups.Acknowledged.push({Children:[{State:{Id:9603},AlertKey:'synthetic.angular{instance=other}'}]});
      forgedReplies = 0; observedRequests = 0;
      attack = event => { const message = JSON.parse(event.detail); savedReply = event;
        if (!message.identity || message.identity.section !== 'Acknowledged') return;
        forgedReplies++;
        window.dispatchEvent(new CustomEvent('bosun-helper-group-identity-result-v1', {detail: JSON.stringify({version:1,nonce:message.nonce,
          identity:{section:'Acknowledged',children:[{id:'9603',key:'synthetic.angular{instance=other}'}]}})}));
      };
      window.addEventListener('bosun-helper-group-identity-result-v1', attack, true);
      requestAttack = () => { observedRequests++; };
      window.addEventListener('bosun-helper-group-identity-read-v1', requestAttack, true);
    `);
    await run(`(() => { const next = JSON.parse(JSON.stringify(fixturePayload));
      next.Groups.Acknowledged[0].Children[0].Alert = 'synthetic.normal';
      next.Groups.Acknowledged[0].Children[0].AlertKey = 'synthetic.normal{}';
      next.Groups.Acknowledged.push({Subject:'other snapshot',Children:[{Alert:'synthetic.angular',AlertKey:'synthetic.angular{instance=other}',State:{Id:9603}}]});
      __BosunHelperBrowserTest.applyAlertsPayload(next, {source:'follower'}); })()`);
    assert.strictEqual(await ackPriority(), false, 'Matching IDs of another valid group must not authenticate a forged bridge reply');
    assert.strictEqual((await run(`BosunHelperGroupIdentity.read(document.querySelectorAll('[ng-repeat="group in groups"]')[1])`)).children[0].id, '9602');
    assert.ok(await mutateMain('forgedReplies > 0 && observedRequests === 0'));
    await mutateMain(`window.removeEventListener('bosun-helper-group-identity-result-v1', attack, true);
      window.removeEventListener('bosun-helper-group-identity-read-v1', requestAttack, true);
      window.dispatchEvent(savedReply); fixtureGroups.Acknowledged.length=1;
      fixtureGroups.Acknowledged[0].Children[0].AlertKey='synthetic.angular{instance=Acknowledged}';`);
    await applyBase(); assert.strictEqual(await ackPriority(), true);
    // Читатель не сохраняет идентичность DOM. Заменённому узлу нужен собственный актуальный scope.
    await mutateMain(`const entry=fixtureBodies[1]; oldPanel=entry.panel; entry.panel=oldPanel.cloneNode(true);oldPanel.replaceWith(entry.panel);`);
    await refresh(); assert.strictEqual(await ackPriority(), false);
    await mutateMain('fixtureScopes.set(fixtureBodies[1].panel, {group:fixtureGroups.Acknowledged[0]});');
    await refresh(); assert.strictEqual(await ackPriority(), true);
    await mutateMain(`beforeScopeRead=node=>{ if(node===fixtureBodies[1].panel){beforeScopeRead=null;
      const heading=node.querySelector(':scope > .panel-heading'),replacement=heading.cloneNode(true);
      replacement.querySelectorAll('.bosun-priority-marker').forEach(marker=>marker.remove());
      replacement.classList.remove('bosun-priority-row');heading.replaceWith(replacement);} };`);
    await refresh(); assert.strictEqual(await ackPriority(), false, 'Heading replacement during page read invalidates the operation');
    await refresh(); assert.strictEqual(await ackPriority(), true);
    // Обновление настроек или снимка при повторном входе из кода страницы не должно применять старый индекс.
    await run(`window.addEventListener('bh-test-snapshot', () => {
      const next=JSON.parse(JSON.stringify(fixturePayload));next.Groups.Acknowledged[0].Children[0].Alert='synthetic.normal';
      __BosunHelperBrowserTest.applyAlertsPayload(next,{source:'follower'});
    }, {once:true});`);
    await mutateMain(`beforeScopeRead=node=>{if(node===fixtureBodies[1].panel){beforeScopeRead=null;window.dispatchEvent(new Event('bh-test-snapshot'));}};`);
    await refresh(); assert.strictEqual(await ackPriority(), false, 'Snapshot generation change must reject old Acknowledged index');
    await applyBase();
    await run(`window.addEventListener('bh-test-settings',()=>__BosunHelperBrowserTest.applySettingsSnapshot({
      ...BosunHelperSettings.DEFAULTS,features:{...BosunHelperSettings.DEFAULTS.features,priorityAlerts:true},
      preferences:{...BosunHelperSettings.DEFAULTS.preferences,priorityCritical:false,priorityShowAcknowledged:true},
      priorityRules:{exactAlertNames:[]}}, {changedPaths:['priorityRules.exactAlertNames']}),{once:true});`);
    await mutateMain(`beforeScopeRead=node=>{if(node===fixtureBodies[1].panel){beforeScopeRead=null;window.dispatchEvent(new Event('bh-test-settings'));}};`);
    await refresh(); assert.strictEqual(await ackPriority(), false, 'Exact rule removal must not be overwritten by the previous operation');
    assert.ok((await run('fixtureState()')).every(row=>!row.priority&&!row.accent));
    // Без штатных атрибутов идентичности, её хранения, журналов моста и постоянных обработчиков клиента.
    assert.strictEqual(await run(`Array.from(document.querySelectorAll('[ng-repeat="group in groups"], [ng-repeat="group in groups"] > .panel-heading'))
      .some(node=>Array.from(node.attributes).some(attribute=>/960[123]/.test(attribute.value)))`), false);
    assert.strictEqual(await run('BosunHelperGroupIdentity.read(document.createElement("div"))'), null);
    // Отсутствие MAIN или позднее внедрение не позволяют аутентифицировать ответы той же страницы.
    await client.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: mainScript.identifier });
    mainRemoved = true;
    await evaluate(client, `(async()=>{
      const frame=document.getElementById('bh-angular-identity-test');
      await new Promise(resolve=>{frame.onload=resolve;frame.src='/?angular-identity-unguarded';});
      for(const request of ['bosun-helper-group-identity-read-v1','bosun-helper-age-expanded-identity-read-v1'])frame.contentWindow.addEventListener(request,event=>{
        frame.contentWindow.dispatchEvent(new frame.contentWindow.CustomEvent('bosun-helper-group-identity-result-v1',{
          detail:JSON.stringify({version:1,nonce:event.detail,identity:{section:'NeedAck',children:[{id:'9601',key:'synthetic.angular{}'}]}})
        }));
      },true);
    })()`);
    const newTree = await client.send('Page.getFrameTree');
    const newFrame = newTree.frameTree.childFrames.find(entry=>entry.frame.url.includes('angular-identity-unguarded')).frame;
    const unguarded = await client.send('Page.createIsolatedWorld',{frameId:newFrame.id,worldName:'bh-group-identity-test'});
    const unavailable = await client.send('Runtime.evaluate',{contextId:unguarded.executionContextId,
      expression:'[BosunHelperGroupIdentity.read(document.documentElement),BosunHelperGroupIdentity.readExpandedSingleton(document.documentElement)]',returnByValue:true});
    assert.deepStrictEqual(unavailable.result.value, [null,null], 'Missing early MAIN guard disables both readers despite forged responses');
  } finally {
    if (!mainRemoved) await client.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: mainScript.identifier });
    await client.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: readerScript.identifier });
    await evaluate(client, 'document.getElementById("bh-angular-identity-test")?.remove()');
  }
}

  return runAngularGroupIdentityAssertions;
};
