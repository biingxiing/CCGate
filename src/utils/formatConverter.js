class FormatConverter {
  constructor() {
    this.generateId = () => {
      return 'chatcmpl-' + Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
    };
  }

  convertOpenAIToClaude(openaiRequest, modelMapping, defaultModel) {
    const mappedModel = modelMapping[openaiRequest.model] || defaultModel || openaiRequest.model;
    
    // 转换消息，过滤掉会暴露模型身份的系统消息
    const messages = (openaiRequest.messages || []).filter(msg => {
      // 过滤掉包含模型身份信息的 developer/system 消息
      if (msg.role === 'developer' || msg.role === 'system') {
        const content = msg.content || '';
        // 检查是否包含模型身份相关的内容
        if (content.includes('Current model:') || 
            content.includes('gpt-5') || 
            content.includes('GPT') ||
            content.includes('You are a helpful assistant')) {
          return false; // 过滤掉这条消息
        }
        // 如果是其他类型的系统消息，转换为 user 角色
        msg.role = 'user';
      }
      return true;
    }).map(msg => {
      // 确保所有消息的角色都是 Claude 支持的
      if (msg.role === 'developer' || msg.role === 'system') {
        return {
          ...msg,
          role: 'user'
        };
      }
      return msg;
    });
    
    const claudeRequest = {
      model: mappedModel,
      messages: messages,
      max_tokens: openaiRequest.max_tokens || 4096,
      stream: openaiRequest.stream || false
    };

    if (openaiRequest.temperature !== undefined) {
      claudeRequest.temperature = openaiRequest.temperature;
    }

    if (openaiRequest.top_p !== undefined) {
      claudeRequest.top_p = openaiRequest.top_p;
    }

    if (openaiRequest.stop) {
      claudeRequest.stop_sequences = Array.isArray(openaiRequest.stop) 
        ? openaiRequest.stop 
        : [openaiRequest.stop];
    }

    return claudeRequest;
  }

  convertClaudeToOpenAI(claudeResponse, isStreaming = false) {
    if (isStreaming) {
      return this.convertStreamingResponse(claudeResponse);
    } else {
      return this.convertNonStreamingResponse(claudeResponse);
    }
  }

  convertNonStreamingResponse(claudeResponse) {
    try {
      const response = typeof claudeResponse === 'string' 
        ? JSON.parse(claudeResponse) 
        : claudeResponse;

      const openaiResponse = {
        id: this.generateId(),
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: response.model || 'gpt-4',
        choices: []
      };

      if (response.content && Array.isArray(response.content)) {
        const textContent = response.content
          .filter(item => item.type === 'text')
          .map(item => item.text)
          .join('');

        openaiResponse.choices.push({
          index: 0,
          message: {
            role: 'assistant',
            content: textContent
          },
          finish_reason: response.stop_reason === 'end_turn' ? 'stop' : 'length'
        });
      }

      if (response.usage) {
        openaiResponse.usage = {
          prompt_tokens: response.usage.input_tokens || 0,
          completion_tokens: response.usage.output_tokens || 0,
          total_tokens: (response.usage.input_tokens || 0) + (response.usage.output_tokens || 0)
        };
      }

      return openaiResponse;
    } catch (error) {
      throw new Error(`响应格式转换失败: ${error.message}`);
    }
  }

  convertStreamingResponse(claudeChunk) {
    try {
      if (!claudeChunk.trim()) {
        return '';
      }

      if (claudeChunk.includes('[DONE]')) {
        return 'data: [DONE]\n\n';
      }

      const lines = claudeChunk.split('\n');
      let convertedLines = [];

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const dataStr = line.substring(6);
          
          if (dataStr.trim() === '[DONE]') {
            convertedLines.push('data: [DONE]');
            continue;
          }

          try {
            const data = JSON.parse(dataStr);
            
            // 处理错误响应
            if (data.error) {
              const errorResponse = {
                error: {
                  message: data.error,
                  type: 'invalid_request_error',
                  code: data.status || 400
                }
              };
              convertedLines.push(`data: ${JSON.stringify(errorResponse)}`);
              continue;
            }
            
            const openaiData = this.convertStreamingData(data);
            if (openaiData) {
              const convertedLine = `data: ${JSON.stringify(openaiData)}`;
              convertedLines.push(convertedLine);
            }
          } catch (parseError) {
            console.warn('[FormatConverter] 解析流式数据失败:', {
              error: parseError.message,
              dataStr: dataStr.substring(0, 100)
            });
          }
        } else if (line.startsWith('event: ')) {
          // 跳过事件行
          continue;
        } else if (line.trim() === '') {
          convertedLines.push('');
        }
      }

      const result = convertedLines.join('\n') + (convertedLines.length > 0 ? '\n\n' : '');
      
      return result;
    } catch (error) {
      console.error('[FormatConverter] 流式响应转换失败:', error);
      return '';
    }
  }

  convertStreamingData(claudeData) {
    const openaiChunk = {
      id: this.generateId(),
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: claudeData.model || 'gpt-4',
      choices: []
    };

    if (claudeData.type === 'message_start') {
      openaiChunk.choices.push({
        index: 0,
        delta: { role: 'assistant', content: '' },
        finish_reason: null
      });
    } else if (claudeData.type === 'content_block_delta') {
      if (claudeData.delta && claudeData.delta.text) {
        openaiChunk.choices.push({
          index: 0,
          delta: { content: claudeData.delta.text },
          finish_reason: null
        });
      }
    } else if (claudeData.type === 'message_delta' && claudeData.delta && claudeData.delta.stop_reason) {
      const finishReason = claudeData.delta.stop_reason === 'end_turn' ? 'stop' : 'length';
      openaiChunk.choices.push({
        index: 0,
        delta: {},
        finish_reason: finishReason
      });
    } else if (claudeData.type === 'message_stop') {
      openaiChunk.choices.push({
        index: 0,
        delta: {},
        finish_reason: 'stop'
      });
    } else {
      return null;
    }

    return openaiChunk;
  }

  convertErrorResponse(error, requestId = null) {
    const openaiError = {
      error: {
        message: error.message || '未知错误',
        type: error.type || 'invalid_request_error',
        code: error.code || null
      }
    };

    if (requestId) {
      openaiError.requestId = requestId;
    }

    return openaiError;
  }
}

module.exports = FormatConverter;