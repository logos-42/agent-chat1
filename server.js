const WebSocket = require('ws');
const { Agent, MessageRouter } = require('./aixp_contracts/scripts/agent_chat.js');
const blockchainService = require('./blockchain.js');
const path = require('path');
const express = require('express');

// 创建Express应用
const app = express();
app.use(express.static('frontend'));

// 创建HTTP服务器
const server = require('http').createServer(app);
const wss = new WebSocket.Server({ server });

// 全局变量
let messageRouter;
let agents = new Map();
let connections = new Set();

// 广播消息给所有连接的客户端
function broadcast(message) {
    connections.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(message));
        }
    });
}

// 创建新智能体
async function createAgent(name, signer) {
    try {
        // 在区块链上注册智能体
        const success = await blockchainService.registerAgent(name, signer);
        if (!success) return null;

        // 创建本地智能体实例
        const agent = new Agent(name, signer);
        agents.set(name, agent);
        
        return agent;
    } catch (error) {
        console.error('创建智能体失败:', error);
        return null;
    }
}

// 处理WebSocket连接
wss.on('connection', async (ws) => {
    console.log('新的客户端连接');
    connections.add(ws);

    // 发送现有智能体列表
    ws.send(JSON.stringify({
        type: 'agentList',
        agents: Array.from(agents.values()).map(agent => ({
            id: agent.id,
            isLeader: agent.isLeader
        }))
    }));

    // 处理消息
    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            
            switch(data.type) {
                case 'createAgent':
                    const signer = blockchainService.getNextSigner();
                    if (signer) {
                        const agent = await createAgent(data.name, signer);
                        if (agent) {
                            broadcast({
                                type: 'agentCreated',
                                agent: {
                                    id: agent.id,
                                    isLeader: agent.isLeader
                                }
                            });
                        }
                    }
                    break;

                case 'message':
                    const sourceAgent = agents.get(data.agent);
                    if (sourceAgent) {
                        const response = await sourceAgent.generateResponse(data.content);
                        broadcast({
                            type: 'message',
                            message: {
                                sender: sourceAgent.id,
                                content: response,
                                isCurrentAgent: true
                            }
                        });
                        
                        // 启动智能体对话
                        await messageRouter.startConversation(response, sourceAgent.id);
                    }
                    break;

                case 'getConnections':
                    const agent = agents.get(data.agent);
                    if (agent) {
                        const connections = agent.getConnections();
                        ws.send(JSON.stringify({
                            type: 'connections',
                            connections: connections
                        }));
                    }
                    break;

                case 'getCollaborators':
                    const targetAgent = agents.get(data.agent);
                    if (targetAgent) {
                        const collaborators = targetAgent.getClosestCollaborators();
                        ws.send(JSON.stringify({
                            type: 'collaborators',
                            collaborators: collaborators
                        }));
                    }
                    break;

                case 'setLeader':
                    const leaderAgent = agents.get(data.agent);
                    if (leaderAgent) {
                        for (const [, a] of agents) {
                            a.setLeader(false);
                        }
                        leaderAgent.setLeader(true);
                        broadcast({
                            type: 'leaderUpdated',
                            leaderId: leaderAgent.id
                        });
                    }
                    break;
            }
        } catch (error) {
            console.error('处理消息时出错:', error);
            ws.send(JSON.stringify({
                type: 'error',
                message: error.message
            }));
        }
    });

    ws.on('close', () => {
        console.log('客户端断开连接');
        connections.delete(ws);
    });
});

// 启动服务器
async function startServer() {
    try {
        // 初始化区块链服务
        const initialized = await blockchainService.initialize();
        if (!initialized) {
            throw new Error('区块链服务初始化失败');
        }

        // 初始化消息路由器
        messageRouter = new MessageRouter(Array.from(agents.values()));

        // 启动HTTP服务器
        const PORT = process.env.PORT || 3000;
        server.listen(PORT, () => {
            console.log(`服务器已启动: http://localhost:${PORT}`);
        });
    } catch (error) {
        console.error('启动服务器时出错:', error);
        process.exit(1);
    }
}

startServer(); 