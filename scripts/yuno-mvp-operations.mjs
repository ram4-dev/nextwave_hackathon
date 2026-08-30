/**
 * Shared MVP operation list for Yuno contract verify + generate.
 * Paths and methods must match contracts/yuno/openapi.json exactly.
 */
export const YUNO_MVP_OPERATIONS = [
  ['post', '/customers'],
  ['post', '/customers/sessions'],
  ['get', '/checkout/customers/sessions/{customer_session}/payment-methods'],
  ['post', '/customers/sessions/{customer_session}/payment-methods'],
  ['get', '/payment-methods/{payment_method_id}'],
  ['get', '/customers/{customer_id}/payment-methods'],
  ['post', '/customers/payment-methods/{payment_method_id}/unenroll'],
  ['post', '/payments'],
  ['get', '/payments/{payment_id}'],
  ['post', '/payments/{payment_id}/transactions/{transaction_id}/capture'],
  ['post', '/payments/{payment_id}/transactions/{transaction_id}/cancel'],
  ['post', '/payments/{id}/transactions/{transaction_id}/refund'],
  ['post', '/payments/{payment_id}/cancel-or-refund'],
  ['post', '/payments/{payment_id}/transactions/{transaction_id}/cancel-or-refund'],
  ['post', '/webhooks'],
  ['get', '/webhooks'],
  ['patch', '/webhooks/{webhook_id}'],
  ['delete', '/webhooks/{webhook_id}'],
];

export const YUNO_MVP_OPERATION_COUNT = YUNO_MVP_OPERATIONS.length;
