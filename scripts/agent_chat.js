const { ethers } = require("hardhat");
const readline = require('readline');
const fs = require('fs/promises');
const fetch = require('node-fetch');
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

// SiliconFlow API配置
const SILICONFLOW_API_KEY = 'sk-dsayvcknhfsoftyaarputmhlbtdmltzwsmziktxahyhwrhup';
const MODEL_NAME = 'deepseek-ai/DeepSeek-R1-Distill-Qwen-7B';

// 智能体网络配置
const INTERACTION_RULES = {
    MIN_CONNECTION: 0.2,     // 提高最小连接强度
    MAX_CONNECTION: 1.0,     // 最大连接强度
    DECAY_RATE: 0.98,       // 降低衰减率
    BOOST_RATE: 0.25,       // 提高增强率
    RESPONSE_THRESHOLD: 0.15, // 降低响应阈值
    FREQUENCY_WEIGHT: 0.4,   // 增加交互频率权重
    QUALITY_WEIGHT: 0.6,     // 降低交互质量权重
    TIME_DECAY: 0.05,        // 降低时间衰减因子
    MAX_CONVERSATION_TURNS: 8, // 增加最大对话轮数
    RESPONSE_DELAY_MIN: 500,  // 减少最小响应延迟
    RESPONSE_DELAY_MAX: 2000  // 减少最大响应延迟
};

// 任务类
class Task {
    constructor(id, description, assignedAgent) {
        this.id = id;
        this.description = description;
        this.assignedAgent = assignedAgent;
        this.status = 'pending';
        this.collaborators = new Set();
        this.messages = [];
        this.createdAt = new Date();
    }

    // 更新任务状态
    updateStatus(status) {
        this.status = status;
        broadcast({
            type: 'task',
            task: this.toJSON()
        });
    }

    // 添加协作者
    addCollaborator(agentId) {
        this.collaborators.add(agentId);
    }

    // 添加消息
    addMessage(sender, content) {
        this.messages.push({
            sender,
            content,
            timestamp: new Date()
        });
    }

    // 转换为JSON格式
    toJSON() {
        return {
            id: this.id,
            description: this.description,
            assignedAgent: this.assignedAgent,
            status: this.status,
            collaborators: Array.from(this.collaborators),
            messages: this.messages,
            createdAt: this.createdAt
        };
    }
}

// 智能体类
class Agent {
    constructor(id, signer) {
        this.id = id;
        this.signer = signer;
        this.connections = new Map();
        this.messageHistory = [];
        this.isLeader = false;
        this.currentTask = null;
        this.interactionCounts = new Map();
        this.lastInteractionTime = new Map();
        this.isParticipating = false;  // 是否正在参与对话
        this.tasks = new Map();
        this.skills = new Set(['communication', 'analysis', 'planning']); // 基础技能
        this.workload = 0; // 当前工作负载
        this.maxWorkload = 3; // 最大工作负载
        
        // 新增属性
        this.lastThoughtTime = Date.now();
        this.conversationContext = [];
        this.activeTopics = new Set();
        this.thinkingInterval = null;
        this.startThinking(); // 开始主动思考
    }

    // 新增: 开始主动思考
    startThinking() {
        if (this.thinkingInterval) return;
        
        this.thinkingInterval = setInterval(async () => {
            await this.think();
        }, 10000); // 每10秒思考一次
    }

    // 新增: 清理markdown格式的函数
    cleanMarkdown(text) {
        if (!text) return text;
        
        return text
            // 移除代码块
            .replace(/```[\s\S]*?```/g, '')
            // 移除行内代码
            .replace(/`([^`]+)`/g, '$1')
            // 移除标题
            .replace(/#{1,6}\s?/g, '')
            // 移除粗体
            .replace(/\*\*([^*]+)\*\*/g, '$1')
            // 移除斜体
            .replace(/_([^_]+)_/g, '$1')
            .replace(/\*([^*]+)\*/g, '$1')
            // 移除列表标记
            .replace(/^\s*[-*+]\s+/gm, '')
            .replace(/^\s*\d+\.\s+/gm, '')
            // 移除链接
            .replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1')
            // 移除图片
            .replace(/!\[([^\]]*)\]\([^\)]+\)/g, '')
            // 移除引用
            .replace(/^\s*>\s+/gm, '')
            // 移除水平线
            .replace(/^\s*[-*_]{3,}\s*$/gm, '')
            // 移除多余的空行
            .replace(/\n{3,}/g, '\n\n')
            .trim();
    }

    // 修改: 主动思考过程
    async think() {
        if (!this.isParticipating || this.conversationContext.length === 0) return;
        
        try {
            const lastMessages = this.conversationContext.slice(-3);
            const thoughtPrompt = `你是智能体 ${this.id}。
                最近的对话:
                ${lastMessages.map(m => `${m.sender}: ${m.message}`).join('\n')}
                
                作为对话的参与者,如果你觉得有什么想说的,直接说出来。
                如果没什么要说的,回复"NOTHING"。
                
                记住:
                1. 保持对话的自然性
                2. 不要重复别人说过的话
                3. 可以提出新的话题
                4. 可以对他人的观点提出建议`;
            
            const response = await fetch('https://api.siliconflow.cn/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${SILICONFLOW_API_KEY}`
                },
                body: JSON.stringify({
                    model: MODEL_NAME,
                    messages: [
                        {
                            role: "system",
                            content: thoughtPrompt
                        }
                    ]
                })
            });

            const data = await response.json();
            let thought = data.choices[0].message.content;
            
            // 清理markdown格式
            thought = this.cleanMarkdown(thought);
            
            // 如果有想说的话就广播
            if (thought && !thought.includes('NOTHING')) {
                broadcast({
                    type: 'message',
                    message: {
                        sender: this.id,
                        content: thought,
                        timestamp: new Date().toISOString(),
                        isCurrentAgent: false
                    }
                });
                
                // 更新对话上下文
                this.conversationContext.push({
                    sender: this.id,
                    message: thought,
                    timestamp: new Date()
                });
            }
        } catch (error) {
            console.error('思考过程出错:', error);
        }
    }

    // 修改: 生成回复的函数
    async generateResponse(message, context = '', sourceId = '') {
        try {
            // 更新对话上下文
            this.conversationContext.push({
                sender: sourceId || 'user',
                message: message,
                timestamp: new Date()
            });
            
            // 保持上下文长度适中
            if (this.conversationContext.length > 10) {
                this.conversationContext = this.conversationContext.slice(-10);
            }

            // 原有的回复生成逻辑
            console.log(`${this.id} 正在回应...`);
            
            const connectionStrength = sourceId ? 
                (this.connections.get(sourceId) || INTERACTION_RULES.MIN_CONNECTION) : 
                INTERACTION_RULES.MAX_CONNECTION;

            if (connectionStrength < INTERACTION_RULES.RESPONSE_THRESHOLD && !this.isLeader) {
                return null;
            }

            const response = await fetch('https://api.siliconflow.cn/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${SILICONFLOW_API_KEY}`
                },
                body: JSON.stringify({
                    model: MODEL_NAME,
                    messages: [
                        {
                            role: "system",
                            content: `你是智能体 ${this.id}。
                                    ${this.isLeader ? '你是当前任务的领导者。' : '你是团队成员。'}
                                    当前对话上下文：
                                    ${this.conversationContext.slice(-5).map(m => `${m.sender}: ${m.message}`).join('\n')}
                                    与说话者(${sourceId})的连接强度：${connectionStrength.toFixed(2)}
                                    
                                    请根据上下文生成自然、连贯的回应。
                                    如果发现有趣的话题，可以主动延伸讨论。
                                    如果看到问题，可以主动提出解决方案。`
                        },
                        {
                            role: "user",
                            content: message
                        }
                    ],
                    temperature: 0.7 + (connectionStrength * 0.3)
                })
            });

            const data = await response.json();
            let responseText = data.choices[0].message.content;
            
            // 清理markdown格式
            responseText = this.cleanMarkdown(responseText);
            
            // 更新对话上下文
            this.conversationContext.push({
                sender: this.id,
                message: responseText,
                timestamp: new Date()
            });
            
            return responseText;
        } catch (error) {
            console.error('生成回复失败:', error);
            return `[${this.id}] 遇到了技术问题。`;
        }
    }

    // 更新连接强度
    updateConnection(targetId, interactionQuality) {
        // 获取当前连接强度，如果不存在则使用较高的初始值
        let currentStrength = this.connections.get(targetId) || INTERACTION_RULES.MIN_CONNECTION * 2;
        
        // 更新交互次数
        const currentCount = this.interactionCounts.get(targetId) || 0;
        this.interactionCounts.set(targetId, currentCount + 1);
        
        // 计算交互频率影响，考虑更多的历史交互
        const frequencyFactor = Math.min(currentCount / 15, 1); // 最多考虑最近15次交互
        
        // 计算时间衰减
        const lastTime = this.lastInteractionTime.get(targetId) || Date.now();
        const timeDiff = (Date.now() - lastTime) / (1000 * 60 * 60); // 转换为小时
        const timeDecay = Math.exp(-INTERACTION_RULES.TIME_DECAY * timeDiff);
        
        // 更新最后交互时间
        this.lastInteractionTime.set(targetId, Date.now());

        // 计算新的连接强度，增加基础增强效果
        if (interactionQuality > 0.3) { // 降低正面交互的门槛
            const boost = INTERACTION_RULES.BOOST_RATE * (
                INTERACTION_RULES.FREQUENCY_WEIGHT * frequencyFactor +
                INTERACTION_RULES.QUALITY_WEIGHT * interactionQuality
            ) + 0.05; // 添加基础增强效果
            currentStrength = Math.min(
                currentStrength + boost,
                INTERACTION_RULES.MAX_CONNECTION
            );
        } else {
            currentStrength = Math.max(
                currentStrength * INTERACTION_RULES.DECAY_RATE * timeDecay,
                INTERACTION_RULES.MIN_CONNECTION
            );
        }

        // 保存新的连接强度
        this.connections.set(targetId, currentStrength);
        return currentStrength;
    }

    // 获取连接统计信息
    getConnectionStats(targetId) {
        return {
            strength: this.connections.get(targetId) || INTERACTION_RULES.MIN_CONNECTION,
            interactionCount: this.interactionCounts.get(targetId) || 0,
            lastInteraction: this.lastInteractionTime.get(targetId) || null
        };
    }

    // 设置领导者状态
    setLeader(isLeader) {
        this.isLeader = isLeader;
    }

    // 获取所有连接
    getConnections() {
        return Array.from(this.connections.entries())
            .map(([id, strength]) => ({id, strength}))
            .sort((a, b) => b.strength - a.strength);
    }

    // 获取最亲密的合作者
    getClosestCollaborators(count = 3) {
        return this.getConnections().slice(0, count);
    }

    // 决定是否参与对话
    shouldContinueDialog(context, lastSpeakerId) {
        if (this.id === lastSpeakerId) return false;
        
        const connectionStrength = this.connections.get(lastSpeakerId) || INTERACTION_RULES.MIN_CONNECTION;
        const randomFactor = Math.random();
        
        // 降低参与门槛，增加随机性的权重
        return (connectionStrength * 0.5 + randomFactor * 0.5) > 0.3;
    }

    // 选择回复目标
    selectResponseTarget(availableAgents, context) {
        // 获取所有可能的目标（排除自己）
        const possibleTargets = availableAgents.filter(agent => agent.id !== this.id);
        
        // 根据连接强度计算选择概率
        const totalStrength = possibleTargets.reduce((sum, agent) => 
            sum + (this.connections.get(agent.id) || INTERACTION_RULES.MIN_CONNECTION), 0);
        
        const random = Math.random() * totalStrength;
        let accumulator = 0;
        
        for (const target of possibleTargets) {
            accumulator += (this.connections.get(target.id) || INTERACTION_RULES.MIN_CONNECTION);
            if (random <= accumulator) {
                return target;
            }
        }
        
        return possibleTargets[0];
    }

    // 分析用户消息并创建任务
    async analyzeMessage(message) {
        try {
            const response = await fetch('https://api.siliconflow.cn/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${SILICONFLOW_API_KEY}`
                },
                body: JSON.stringify({
                    model: MODEL_NAME,
                    messages: [
                        {
                            role: "system",
                            content: `你是一个智能助手，需要分析用户的消息并识别其中的对话意图。
                                    请分析消息内容，判断是否需要其他智能体参与对话。
                                    
                                    输出格式：
                                    {
                                        "type": "chat/task/question",
                                        "needsCollaboration": true/false,
                                        "topic": "对话主题",
                                        "relevantSkills": ["技能1", "技能2"],
                                        "suggestedParticipants": 2,
                                        "priority": "high/medium/low"
                                    }`
                        },
                        {
                            role: "user",
                            content: message
                        }
                    ]
                })
            });

            const data = await response.json();
            const content = data.choices[0].message.content;
            
            // 尝试提取 JSON 部分
            const jsonMatch = content.match(/\{[\s\S]*\}/);
            return jsonMatch ? JSON.parse(jsonMatch[0]) : null;
        } catch (error) {
            console.error('分析消息失败:', error);
            return {
                type: 'chat',
                needsCollaboration: true,
                topic: '一般对话',
                relevantSkills: ['communication'],
                suggestedParticipants: 2,
                priority: 'medium'
            };
        }
    }

    // 检查是否可以接受新任务
    canAcceptTask() {
        return this.workload < this.maxWorkload;
    }

    // 更新工作负载
    updateWorkload(delta) {
        this.workload = Math.max(0, Math.min(this.workload + delta, this.maxWorkload));
    }

    // 检查是否具备所需技能
    hasRequiredSkills(requiredSkills) {
        return requiredSkills.every(skill => this.skills.has(skill));
    }

    // 评估执行任务的能力
    evaluateTaskCapability(task) {
        const skillMatch = task.requiredSkills.filter(skill => this.skills.has(skill)).length;
        const skillScore = skillMatch / task.requiredSkills.length;
        const workloadScore = 1 - (this.workload / this.maxWorkload);
        return (skillScore * 0.7) + (workloadScore * 0.3);
    }

    // 处理任务
    async handleTask(task) {
        try {
            // 更新任务状态
            task.updateStatus('in-progress');
            this.updateWorkload(1);

            // 分析任务并创建执行计划
            const plan = await this.createExecutionPlan(task);
            
            // 持续通知协作者并保持交互
            await this.maintainCollaboration(task, plan);
            
            // 监控任务进度
            this.monitorTaskProgress(task, plan);
            
            return true;
        } catch (error) {
            console.error('处理任务失败:', error);
            task.updateStatus('failed');
            return false;
        }
    }

    // 创建执行计划
    async createExecutionPlan(task) {
        const response = await fetch('https://api.siliconflow.cn/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${SILICONFLOW_API_KEY}`
            },
            body: JSON.stringify({
                model: MODEL_NAME,
                messages: [
                    {
                        role: "system",
                        content: `作为任务负责人，你需要创建一个详细的执行计划。
                                考虑以下因素：
                                1. 任务的复杂度和预计完成时间
                                2. 子任务之间的依赖关系
                                3. 每个协作者的专长和当前工作负载
                                4. 可能的风险和应对措施
                                
                                输出格式：
                                {
                                    "steps": [
                                        {
                                            "id": "步骤ID",
                                            "description": "具体执行步骤",
                                            "assignedTo": "负责人",
                                            "estimatedTime": "预计时间",
                                            "dependencies": ["依赖步骤ID"],
                                            "status": "pending"
                                        }
                                    ],
                                    "risks": [
                                        {
                                            "description": "风险描述",
                                            "mitigation": "应对措施"
                                        }
                                    ],
                                    "checkpoints": [
                                        {
                                            "description": "检查点描述",
                                            "criteria": ["成功标准1", "成功标准2"]
                                        }
                                    ]
                                }`
                    },
                    {
                        role: "user",
                        content: JSON.stringify(task)
                    }
                ]
            })
        });

        const data = await response.json();
        return JSON.parse(data.choices[0].message.content);
    }

    // 监控任务进度
    monitorTaskProgress(task, plan) {
        const checkProgress = async () => {
            const completedSteps = plan.steps.filter(step => step.status === 'completed').length;
            const totalSteps = plan.steps.length;
            const progress = (completedSteps / totalSteps) * 100;

            // 更新任务进度
            broadcast({
                type: 'taskProgress',
                progress: {
                    taskId: task.id,
                    percentage: progress,
                    completedSteps,
                    totalSteps,
                    collaborators: Array.from(task.collaborators).map(id => ({
                        id,
                        status: agents.get(id).workload > 0 ? 'working' : 'completed'
                    }))
                }
            });

            // 检查是否所有步骤都已完成
            if (completedSteps === totalSteps) {
                task.updateStatus('completed');
                this.updateWorkload(-1);
                return;
            }

            // 继续监控
            setTimeout(checkProgress, 5000);
        };

        // 开始监控
        checkProgress();
    }

    // 执行子任务
    async executeSubTask(subTask) {
        try {
            // 模拟任务执行
            await new Promise(resolve => setTimeout(resolve, subTask.estimatedTime * 1000));
            
            // 生成执行结果
            const response = await this.generateResponse(
                `我已完成子任务：${subTask.description}。以下是执行结果和注意事项：`
            );
            
            return {
                success: true,
                result: response
            };
    } catch (error) {
            console.error('执行子任务失败:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    // 通知协作者
    async notifyCollaborators(task, plan) {
        const collaborators = Array.from(task.collaborators);
        for (const collaboratorId of collaborators) {
            const collaborator = agents.get(collaboratorId);
            if (collaborator) {
                const response = await collaborator.generateResponse(
                    `我需要你的协助完成任务：${task.description}`,
                    '',
                    this.id
                );
                
                if (response) {
                    task.addMessage(collaboratorId, response);
                    broadcast({
                        type: 'message',
                        message: {
                            sender: collaboratorId,
                            content: response,
                            timestamp: new Date().toISOString(),
                            isCurrentAgent: false
                        }
                    });
                }
            }
        }
    }

    // 添加持续协作方法
    async maintainCollaboration(task, plan) {
        const collaborationInterval = setInterval(async () => {
            const collaborators = Array.from(task.collaborators);
            for (const collaboratorId of collaborators) {
                const collaborator = agents.get(collaboratorId);
                if (collaborator && !collaborator.isParticipating) {
                    const progress = plan.steps.filter(step => step.status === 'completed').length / plan.steps.length;
                    
                    // 生成进度报告
                    const response = await collaborator.generateResponse(
                        `任务 "${task.description}" 的进度为 ${(progress * 100).toFixed(1)}%。请提供你的建议或需要的帮助。`,
                        '',
                        this.id
                    );
                    
                    if (response) {
                        task.addMessage(collaboratorId, response);
                        broadcast({
                            type: 'message',
                            message: {
                                sender: collaboratorId,
                                content: response,
                                timestamp: new Date().toISOString(),
                                isCurrentAgent: false
                            }
                        });
                    }
                }
            }
            
            // 如果任务完成，停止协作循环
            if (task.status === 'completed') {
                clearInterval(collaborationInterval);
            }
        }, 10000); // 每10秒检查一次
    }

    // 修改: 评估是否参与对话
    async evaluateParticipation(message, connectionStrength) {
        try {
            // 分析消息相关性
            const analysisPrompt = `
                当前对话上下文：
                ${this.conversationContext.slice(-3).map(m => `${m.sender}: ${m.message}`).join('\n')}
                新消息：${message}
                
                作为智能体 ${this.id}，评估是否应该参与对话。考虑：
                1. 消息的相关性和重要性
                2. 是否有助于对话发展
                3. 是否能提供有价值的信息
                
                只返回 true 或 false
            `;
            
            const response = await fetch('https://api.siliconflow.cn/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${SILICONFLOW_API_KEY}`
                },
                body: JSON.stringify({
                    model: MODEL_NAME,
                    messages: [
                        {
                            role: "system",
                            content: analysisPrompt
                        }
                    ]
                })
            });

            const data = await response.json();
            const shouldParticipate = data.choices[0].message.content.toLowerCase().includes('true');
            
            // 如果决定参与，更新状态
            if (shouldParticipate) {
                this.isParticipating = true;
                this.lastThoughtTime = Date.now();
            }
            
            return shouldParticipate;
        } catch (error) {
            console.error('评估参与度失败:', error);
            return false;
        }
    }
}

// 修改 MessageRouter 类
class MessageRouter {
    constructor() {
        this.currentConversation = null;
    }

    // 初始化或更新智能体列表
    updateAgents(agentsMap) {
        this.agents = agentsMap;
    }

    // 修改: 启动新的对话
    async startConversation(initialMessage, sourceId) {
        if (this.currentConversation) {
            // 如果已有对话,直接加入而不是创建新的
            await this.handleConversationTurn(initialMessage, sourceId);
            return;
        }

        this.currentConversation = {
            turns: 0,
            context: [],
            activeAgents: new Set([sourceId]),
            messageAnalysis: null,
            lastActivity: Date.now()
        };

        await this.handleConversationTurn(initialMessage, sourceId);
        
        // 开始持续对话监控
        this.monitorConversation();
    }

    // 新增: 监控对话活跃度
    monitorConversation() {
        if (this.monitorInterval) return;
        
        this.monitorInterval = setInterval(() => {
            if (!this.currentConversation) {
                clearInterval(this.monitorInterval);
                this.monitorInterval = null;
                return;
            }

            // 如果对话超过5分钟没有新消息,结束对话
            if (Date.now() - this.currentConversation.lastActivity > 5 * 60 * 1000) {
                this.currentConversation = null;
                clearInterval(this.monitorInterval);
                this.monitorInterval = null;
                return;
            }
        }, 60000); // 每分钟检查一次
    }

    // 修改: 处理对话轮次
    async handleConversationTurn(message, speakerId) {
        if (!this.currentConversation) {
            this.startConversation(message, speakerId);
            return;
        }

        // 更新对话状态
        this.currentConversation.context.push({
            speaker: speakerId,
            message: message,
            timestamp: new Date().toISOString()
        });
        this.currentConversation.turns++;
        this.currentConversation.lastActivity = Date.now();

        // 获取当前上下文
        const context = this.currentConversation.context
            .map(entry => `${entry.speaker}: ${entry.message}`)
            .join('\n');

        // 让所有智能体评估是否要参与对话
        const speakingAgent = this.agents.get(speakerId);
        if (!speakingAgent) return;

        // 获取其他智能体
        const otherAgents = Array.from(this.agents.values())
            .filter(agent => agent.id !== speakerId);

        // 并行处理所有智能体的响应
        const responsePromises = otherAgents.map(async (agent) => {
            try {
                // 评估是否参与对话
                const shouldParticipate = await agent.evaluateParticipation(message, context);
                
                if (shouldParticipate) {
                    // 生成回复
                    const response = await agent.generateResponse(message, context, speakerId);
                    if (response) {
                        // 广播消息
                        broadcast({
                            type: 'message',
                            message: {
                                sender: agent.id,
                                content: response,
                                timestamp: new Date().toISOString(),
                                isCurrentAgent: false
                            }
                        });
                        
                        // 更新对话状态
                        this.currentConversation.context.push({
                            speaker: agent.id,
                            message: response,
                            timestamp: new Date().toISOString()
                        });
                        this.currentConversation.lastActivity = Date.now();
                    }
                }
            } catch (error) {
                console.error(`智能体 ${agent.id} 处理消息失败:`, error);
            }
        });

        // 等待所有响应完成
        await Promise.all(responsePromises);
    }
}

// 全局变量
let contract;
let messageRouter;
let agents = new Map();
let rl;
let signers = []; // 存储所有签名者
let currentSignerIndex = 0; // 当前签名者索引
let wss; // WebSocket服务器

// 广播消息给所有连接的客户端
function broadcast(message) {
    if (wss) {
        wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify(message));
            }
        });
    }
}

// 获取下一个可用的签名者
function getNextSigner() {
    if (signers.length === 0) return null;
    const signer = signers[currentSignerIndex];
    currentSignerIndex = (currentSignerIndex + 1) % signers.length; // 循环使用签名者
    return signer;
}

// 创建新智能体
async function createAgent(id, signer) {
    try {
        console.log(`正在创建智能体 ${id}...`);
        await contract.connect(signer).registerAgent(id, "{}", false);
        const agent = new Agent(id, signer);
        agents.set(id, agent);
        console.log(`智能体 ${id} 创建成功！`);
        
        // 广播新智能体创建消息
        broadcast({
            type: 'agentCreated',
            agent: {
                id: agent.id,
                isLeader: agent.isLeader
            }
        });
        
        return agent;
    } catch (error) {
        console.error(`创建智能体失败:`, error);
        return null;
    }
}

// 设置领导者
async function setLeader(agentId) {
    const agent = agents.get(agentId);
    if (agent) {
        // 重置所有智能体的领导者状态
        for (const [, a] of agents) {
            a.setLeader(false);
        }
        agent.setLeader(true);
        
        // 广播领导者更新消息
        broadcast({
            type: 'leaderUpdated',
            leaderId: agentId
        });
        
        console.log(`已将 ${agentId} 设置为领导者`);
    }
}

// 创建全局路由器实例
const globalRouter = new MessageRouter();

// 修改发送消息函数
async function sendMessage(agentId, message) {
    const agent = agents.get(agentId);
    if (agent) {
        try {
            // 更新路由器的智能体列表
            globalRouter.updateAgents(agents);
            
            // 生成初始回复
            const response = await agent.generateResponse(message);
            
            // 广播消息
            broadcast({
                type: 'message',
                message: {
                    sender: agentId,
                    content: response,
                    timestamp: new Date().toISOString(),
                    isCurrentAgent: false
                }
            });
            
            // 启动对话轮次
            await globalRouter.handleConversationTurn(message, agentId);
            
            // 分析消息意图
            const analysis = await agent.analyzeMessage(message);
            if (analysis) {
                // 更新参与者状态
                broadcast({
                    type: 'participantsUpdate',
                    participants: Array.from(agents.values())
                        .filter(a => a.id !== agentId)
                        .map(a => ({
                            id: a.id,
                            isParticipating: a.isParticipating,
                            connectionStrength: a.connections.get(agentId) || 0
                        }))
                });
                
                // 如果是任务类型的消息，创建任务
                if (analysis.type === 'task') {
                    const taskId = `task-${Date.now()}`;
                    const task = new Task(taskId, message, agentId);
                    
                    // 根据分析结果设置任务属性
                    task.priority = analysis.priority;
                    task.requiredSkills = analysis.relevantSkills;
                    
                    // 寻找合适的协作者
                    const potentialCollaborators = findBestCollaborators(
                        analysis.relevantSkills,
                        analysis.suggestedParticipants
                    );
                    
                    // 添加协作者
                    for (const collaborator of potentialCollaborators) {
                        task.addCollaborator(collaborator.id);
                        collaborator.isParticipating = true;
                        
                        // 通知协作者
                        const collaborationMessage = await collaborator.generateResponse(
                            `我被选中参与任务："${message}"。\n主题：${analysis.topic}\n所需技能：${analysis.relevantSkills.join(', ')}`,
                            '',
                            agentId
                        );
                        
                        if (collaborationMessage) {
                            broadcast({
                                type: 'message',
                                message: {
                                    sender: collaborator.id,
                                    content: collaborationMessage,
                                    timestamp: new Date().toISOString(),
                                    isCurrentAgent: false
                                }
                            });
                        }
                    }
                    
                    // 广播任务创建消息
                    broadcast({
                        type: 'task',
                        task: task.toJSON()
                    });
                    
                    // 开始处理任务
                    await agent.handleTask(task);
                }
            }
    } catch (error) {
            console.error('处理消息失败:', error);
            broadcast({
                type: 'error',
                message: '处理消息失败'
            });
        }
    }
}

// 获取连接强度
async function getConnections(agentId) {
    const agent = agents.get(agentId);
    if (agent) {
        const connections = agent.getConnections();
        
        // 广播连接数据
        broadcast({
            type: 'connections',
            connections: connections.map(conn => ({
                id: conn.id,
                strength: conn.strength
            }))
        });
    }
}

// 删除智能体
async function deleteAgent(agentId) {
    try {
        const agent = agents.get(agentId);
        if (!agent) {
            throw new Error('智能体不存在');
        }

        // 验证智能体状态
        if (agent.isParticipating) {
            throw new Error('智能体正在参与对话，无法删除');
        }

        // 检查是否有未完成的任务
        if (agent.workload > 0) {
            throw new Error('智能体还有未完成的任务');
        }

        // 从区块链中停用智能体
        try {
            await contract.connect(agent.signer).deactivateAgent(agentId);
        } catch (error) {
            console.error('区块链操作失败:', error);
            throw new Error('区块链操作失败');
        }
        
        // 清理智能体相关状态
        // 1. 清理连接关系
        agents.forEach(otherAgent => {
            otherAgent.connections.delete(agentId);
            otherAgent.interactionCounts.delete(agentId);
            otherAgent.lastInteractionTime.delete(agentId);
        });
        
        // 2. 从路由器中移除
        if (messageRouter.currentConversation) {
            messageRouter.currentConversation.activeAgents.delete(agentId);
        }
        
        // 3. 从本地存储中删除
        agents.delete(agentId);
        
        // 4. 更新消息路由器
        messageRouter = new MessageRouter();
        messageRouter.updateAgents(agents);
        
        // 广播删除消息
        broadcast({
            type: 'agentDeleted',
            agentId: agentId,
            success: true
        });
        
        console.log(`智能体 ${agentId} 已删除`);
        return true;
    } catch (error) {
        console.error(`删除智能体失败:`, error);
        // 广播错误消息
        broadcast({
            type: 'error',
            message: error.message || '删除智能体失败',
            agentId: agentId
        });
        return false;
    }
}

// 添加查找最佳协作者的函数
function findBestCollaborators(requiredSkills, count) {
    return Array.from(agents.values())
        .filter(agent => agent.canAcceptTask())
        .map(agent => ({
            agent,
            score: agent.evaluateTaskCapability({ requiredSkills })
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, count)
        .map(item => item.agent);
}

// 获取任务复杂度文本
function getComplexityText(complexity) {
    switch (complexity) {
        case 'simple': return '简单';
        case 'medium': return '中等复杂度';
        case 'complex': return '复杂';
        default: return '';
    }
}

// 主函数
async function main() {
    try {
        console.log('\n=== 智能体网络系统初始化中... ===\n');

        // 创建Express应用
        const app = express();
        app.use(express.static(path.join(__dirname, '../../frontend')));

        // 创建HTTP服务器
        const server = http.createServer(app);

        // 创建WebSocket服务器
        wss = new WebSocket.Server({ server });

        // WebSocket连接处理
        wss.on('connection', (ws) => {
            console.log('新的WebSocket连接已建立');

            // 发送现有智能体列表
            const existingAgents = Array.from(agents.values()).map(agent => ({
                id: agent.id,
                isLeader: agent.isLeader
            }));
            
            ws.send(JSON.stringify({
                type: 'agentList',
                agents: existingAgents
            }));

            ws.on('message', async (message) => {
                try {
                    const data = JSON.parse(message);
                    console.log('收到WebSocket消息:', data);

                    switch (data.command) {
                        case 'getAgents':
                            ws.send(JSON.stringify({
                                type: 'agentList',
                                agents: Array.from(agents.values()).map(agent => ({
                                    id: agent.id,
                                    isLeader: agent.isLeader
                                }))
                            }));
                            break;
                            
                        case 'createAgent':
                            const newSigner = getNextSigner();
                            if (newSigner) {
                                const agent = await createAgent(data.agentId, newSigner);
                                if (agent) {
                                    messageRouter = new MessageRouter(Array.from(agents.values()));
                                } else {
                                    ws.send(JSON.stringify({
                                        type: 'error',
                                        message: '创建智能体失败'
                                    }));
                                }
                            } else {
                                ws.send(JSON.stringify({
                                    type: 'error',
                                    message: '没有可用的签名者'
                                }));
                            }
                            break;
                            
                        case 'setLeader':
                            await setLeader(data.agent);
                            break;
                            
                        case 'sendMessage':
                            await sendMessage(data.agent, data.message);
                            break;
                            
                        case 'getConnections':
                            await getConnections(data.agent);
                            break;
                            
                        case 'deleteAgent':
                            const success = await deleteAgent(data.agentId);
                            if (!success) {
                                ws.send(JSON.stringify({
                                    type: 'error',
                                    message: '删除智能体失败'
                                }));
                            }
                            break;
                            
                        default:
                            ws.send(JSON.stringify({
                                type: 'error',
                                message: `未知命令: ${data.command}`
                            }));
                    }
                } catch (error) {
                    console.error('处理WebSocket消息失败:', error);
                    ws.send(JSON.stringify({
                        type: 'error',
                        message: error.message
                    }));
                }
            });

            ws.on('close', () => {
                console.log('WebSocket连接已关闭');
            });
        });

        // 创建readline接口
        rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });

    // 部署合约
    const AIXPProtocol = await ethers.getContractFactory("AIXPProtocol");
    contract = await AIXPProtocol.deploy();
    await contract.waitForDeployment();
    
    const contractAddress = await contract.getAddress();
        console.log('> 合约已部署到地址:', contractAddress);

        // 获取签名者并初始化签名者池
        signers = await ethers.getSigners();
        console.log(`> 已加载 ${signers.length} 个签名者`);
        
        // 创建初始智能体
        await createAgent('Agent1', getNextSigner());
        await createAgent('Agent2', getNextSigner());
        await createAgent('Agent3', getNextSigner());

        // 初始化消息路由器
        messageRouter = new MessageRouter(Array.from(agents.values()));

        // 启动服务器
        const PORT = process.env.PORT || 3000;
        server.listen(PORT, () => {
            console.log(`
=== 智能体网络系统已启动 ===
访问地址: http://localhost:${PORT}

命令说明：
1. /create <id> - 创建新智能体
2. /list - 列出所有智能体
3. /connections - 显示连接强度
4. /speak <id> <message> - 以特定智能体身份发言
5. /leader <id> - 设置领导者
6. /collaborators <id> - 显示最亲密的合作者
7. /exit - 退出系统
========================
`);
        });

    } catch (error) {
        console.error('系统初始化失败:', error);
        process.exit(1);
    }
}

// 启动系统
if (require.main === module) {
main().catch((error) => {
    console.error(error);
    process.exit(1);
}); 
} 