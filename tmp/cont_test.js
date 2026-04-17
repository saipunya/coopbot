(async ()=>{
  const cont=require('./services/lawChatbotMainChatContinuation');
  const svc=require('./services/lawChatbotService');
  const longText='ข้อมูลทดลอง '.repeat(2000);
  const richState=cont.createContinuationSessionState({
    target:'all',
    originalMessage:'E2E-token-change',
    effectiveMessage:'E2E-token-change',
    sources:[{
      source:'knowledge_base',
      id:null,
      content:longText,
      continuationMode:'text',
      continuationNextOffset:0,
      continuationChunkId:null,
      continuationChunkOffset:0,
      continuationTotalLength:longText.length,
      continuationHasMore:true
    }]
  });
  const session={};
  cont.setSessionContinuationState(session, richState);
  const token0=cont.signContinuationToken(richState);
  const res1=await svc.replyToChat({ continueFromPrevious:true, continuationToken:token0 }, session);
  const token1=res1.continuation && res1.continuation.token ? res1.continuation.token : null;
  const res2=await svc.replyToChat({ continueFromPrevious:true, continuationToken:token1 }, session);
  console.log('res1.available',res1.continuation && res1.continuation.available,'token1?',!!token1,'len', (res1.answer||'').length);
  console.log('res2.available',res2.continuation && res2.continuation.available,'token2?',!!(res2.continuation && res2.continuation.token),'len',(res2.answer||'').length);
  console.log('\nans1 start:\n', (res1.answer||'').slice(0,300));
  console.log('\nans2 start:\n', (res2.answer||'').slice(0,300));
  console.log('\noverlap?', (res1.answer||'').includes((res2.answer||'').slice(0,80)) );
  process.exit(0);
})();
