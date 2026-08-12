export type KnowledgeQueryChannel = 'DOCUMENT' | 'SQL' | 'RELATIONSHIP' | 'BUSINESS_API';

export interface KnowledgeQueryRoute {
  readonly primary: KnowledgeQueryChannel;
  readonly fallback: readonly KnowledgeQueryChannel[];
  readonly reasonCode: string;
}

const SQL_INTENT =
  /(同比|环比|合计|总计|总和|平均|均值|最大|最小|多少|是多少|sum|average|avg|maximum|minimum|year[- ]over[- ]year|month[- ]over[- ]month|quarter[- ]over[- ]quarter)/iu;
const DOCUMENT_EXPLANATION_INTENT =
  /(原文|含义|如何理解|怎样理解|怎么理解|怎样表述|怎么表述|如何表述|解释|说明|描述|概括|规定|要求|可引用|what does|how is .+ (?:described|stated)|meaning|explain|describe|summari[sz]e)/iu;
const RELATIONSHIP_INTENT =
  /(关系|关联|依赖|隶属|属于|负责人|上下游|影响谁|谁影响|relationship|depend|belongs to|reports to|owner of)/iu;
const BUSINESS_API_INTENT =
  /(当前|实时|今天|现在|最新状态|剩余|待办|进度|是否延期|current|live|today|latest status|remaining|overdue)/iu;
const BUSINESS_OBJECT =
  /(项目|任务|审批|交付物|指标|成员|project|task|approval|deliverable|metric|member)/iu;

export function routeKnowledgeQuery(query: string): KnowledgeQueryRoute {
  const normalized = query.trim();
  // A quoted table fragment can contain words such as "Average" without the
  // user asking the system to calculate anything. Explanation/quotation
  // questions remain document retrieval; otherwise the SQL route would skip
  // the semantic channel and misclassify ordinary source-grounded questions.
  if (DOCUMENT_EXPLANATION_INTENT.test(normalized)) {
    return {
      primary: 'DOCUMENT',
      fallback: [],
      reasonCode: 'KNOWLEDGE_ROUTE_DOCUMENT_EXPLANATION',
    };
  }
  if (SQL_INTENT.test(normalized)) {
    return {
      primary: 'SQL',
      fallback: ['DOCUMENT', 'RELATIONSHIP'],
      reasonCode: 'KNOWLEDGE_ROUTE_ANALYTICAL_INTENT',
    };
  }
  if (BUSINESS_API_INTENT.test(normalized) && BUSINESS_OBJECT.test(normalized)) {
    return {
      primary: 'BUSINESS_API',
      fallback: ['DOCUMENT'],
      reasonCode: 'KNOWLEDGE_ROUTE_LIVE_BUSINESS_STATE',
    };
  }
  if (RELATIONSHIP_INTENT.test(normalized)) {
    return {
      primary: 'RELATIONSHIP',
      fallback: ['DOCUMENT'],
      reasonCode: 'KNOWLEDGE_ROUTE_RELATIONSHIP_INTENT',
    };
  }
  return {
    primary: 'DOCUMENT',
    fallback: [],
    reasonCode: 'KNOWLEDGE_ROUTE_DOCUMENT_INTENT',
  };
}
