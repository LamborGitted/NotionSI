// Trim only at a user boundary so tool results never outlive their tool calls.
export function trimConversation(messages, max = 40) {
  if(messages.length<=max)return messages;
  let start=messages.length-max;
  while(start<messages.length&&messages[start].role!=='user')start++;
  return start<messages.length?messages.slice(start):messages;
}
