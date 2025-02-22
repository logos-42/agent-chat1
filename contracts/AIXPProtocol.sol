// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/**
 * @title AIXPProtocol
 * @dev 实现多智能体之间的通信协议
 */
contract AIXPProtocol {
    // 智能体结构
    struct Agent {
        address owner;           // 智能体所有者地址
        string metadata;         // 智能体元数据（JSON格式）
        bool isActive;          // 智能体是否活跃
        uint256 messageCount;   // 发送的消息数量
        uint256 lastActive;     // 最后活跃时间
        bool isScorer;          // 是否为评分员
    }

    // 消息结构
    struct Message {
        address sender;         // 发送者地址
        string fromAgentId;     // 发送者ID
        string toAgentId;       // 接收者ID
        string messageType;     // 消息类型
        string content;         // 消息内容（加密后的JSON）
        string ipfsHash;        // IPFS哈希（用于存储大文件）
        uint256 timestamp;      // 时间戳
        bool isProcessed;       // 是否已处理
        uint256 score;          // 消息评分
    }

    // 评分结构
    struct Score {
        uint256 score;          // 评分
        string fromAgentId;     // 评分者ID
        uint256 timestamp;      // 评分时间
    }

    // 连接强度结构
    struct Connection {
        uint256 strength;      // 连接强度（0-1000）
        uint256 lastUpdate;    // 最后更新时间
    }

    // 状态变量
    mapping(string => Agent) public agents;              // 智能体注册表
    mapping(bytes32 => Message) public messages;         // 消息存储
    mapping(string => bytes32[]) public agentMessages;   // 智能体的消息列表
    mapping(bytes32 => Score) public messageScores;      // 消息评分
    mapping(string => mapping(string => Connection)) public connections;

    // 事件
    event AgentRegistered(string agentId, address owner, string metadata);
    event MessageSent(
        bytes32 messageId, 
        string fromAgentId, 
        string toAgentId, 
        string messageType,
        string content
    );
    event MessageProcessed(bytes32 messageId, string toAgentId);
    event MessageScored(bytes32 messageId, string scorerAgentId, uint256 score);
    event ConnectionUpdated(string fromAgentId, string toAgentId, uint256 strength);

    // 修饰器
    modifier onlyAgentOwner(string memory agentId) {
        require(agents[agentId].owner == msg.sender, "Not agent owner");
        _;
    }

    modifier agentExists(string memory agentId) {
        require(agents[agentId].isActive, "Agent does not exist");
        _;
    }

    /**
     * @dev 注册新的智能体
     * @param agentId 智能体ID
     * @param metadata 智能体元数据
     * @param isScorer 是否为评分员
     */
    function registerAgent(string memory agentId, string memory metadata, bool isScorer) public {
        require(!agents[agentId].isActive, "Agent already exists");
        
        agents[agentId] = Agent({
            owner: msg.sender,
            metadata: metadata,
            isActive: true,
            messageCount: 0,
            lastActive: block.timestamp,
            isScorer: isScorer
        });

        emit AgentRegistered(agentId, msg.sender, metadata);
    }

    /**
     * @dev 发送消息
     * @param fromAgentId 发送者ID
     * @param toAgentId 接收者ID
     * @param messageType 消息类型
     * @param content 消息内容
     * @param ipfsHash IPFS哈希
     */
    function sendMessage(
        string memory fromAgentId,
        string memory toAgentId,
        string memory messageType,
        string memory content,
        string memory ipfsHash
    ) public onlyAgentOwner(fromAgentId) agentExists(toAgentId) {
        bytes32 messageId = keccak256(abi.encodePacked(
            fromAgentId,
            toAgentId,
            block.timestamp,
            agents[fromAgentId].messageCount
        ));

        messages[messageId] = Message({
            sender: msg.sender,
            fromAgentId: fromAgentId,
            toAgentId: toAgentId,
            messageType: messageType,
            content: content,
            ipfsHash: ipfsHash,
            timestamp: block.timestamp,
            isProcessed: false,
            score: 0
        });

        agentMessages[toAgentId].push(messageId);
        agents[fromAgentId].messageCount++;
        agents[fromAgentId].lastActive = block.timestamp;

        emit MessageSent(messageId, fromAgentId, toAgentId, messageType, content);
    }

    /**
     * @dev 标记消息为已处理
     * @param messageId 消息ID
     */
    function processMessage(bytes32 messageId) public {
        Message storage message = messages[messageId];
        require(agents[message.toAgentId].owner == msg.sender, "Not message recipient");
        require(!message.isProcessed, "Message already processed");

        message.isProcessed = true;
        agents[message.toAgentId].lastActive = block.timestamp;

        emit MessageProcessed(messageId, message.toAgentId);
    }

    /**
     * @dev 获取智能体的未处理消息数量
     * @param agentId 智能体ID
     */
    function getUnprocessedMessageCount(string memory agentId) public view returns (uint256) {
        bytes32[] memory agentMsgs = agentMessages[agentId];
        uint256 count = 0;
        
        for (uint256 i = 0; i < agentMsgs.length; i++) {
            if (!messages[agentMsgs[i]].isProcessed) {
                count++;
            }
        }
        
        return count;
    }

    /**
     * @dev 获取智能体的所有消息ID
     * @param agentId 智能体ID
     */
    function getAgentMessages(string memory agentId) public view returns (bytes32[] memory) {
        return agentMessages[agentId];
    }

    /**
     * @dev 更新智能体元数据
     * @param agentId 智能体ID
     * @param metadata 新的元数据
     */
    function updateAgentMetadata(string memory agentId, string memory metadata) public onlyAgentOwner(agentId) {
        agents[agentId].metadata = metadata;
        agents[agentId].lastActive = block.timestamp;
    }

    /**
     * @dev 停用智能体
     * @param agentId 智能体ID
     */
    function deactivateAgent(string memory agentId) public onlyAgentOwner(agentId) {
        agents[agentId].isActive = false;
    }

    /**
     * @dev 对消息进行评分
     * @param messageId 消息ID
     * @param scorerAgentId 评分者ID
     * @param score 评分
     */
    function scoreMessage(bytes32 messageId, string memory scorerAgentId, uint256 score) public {
        require(agents[scorerAgentId].isScorer, "Not a scorer agent");
        require(agents[scorerAgentId].owner == msg.sender, "Not scorer owner");
        require(score <= 100, "Score must be between 0 and 100");

        messageScores[messageId] = Score({
            score: score,
            fromAgentId: scorerAgentId,
            timestamp: block.timestamp
        });

        emit MessageScored(messageId, scorerAgentId, score);
    }

    /**
     * @dev 更新智能体之间的连接强度
     * @param fromAgentId 源智能体ID
     * @param toAgentId 目标智能体ID
     * @param strength 连接强度（0-1000）
     */
    function updateConnection(
        string memory fromAgentId,
        string memory toAgentId,
        uint256 strength
    ) public onlyAgentOwner(fromAgentId) agentExists(toAgentId) {
        require(strength <= 1000, "Strength must be between 0 and 1000");
        
        connections[fromAgentId][toAgentId] = Connection({
            strength: strength,
            lastUpdate: block.timestamp
        });

        emit ConnectionUpdated(fromAgentId, toAgentId, strength);
    }

    /**
     * @dev 获取智能体之间的连接强度
     * @param fromAgentId 源智能体ID
     * @param toAgentId 目标智能体ID
     */
    function getConnection(
        string memory fromAgentId,
        string memory toAgentId
    ) public view returns (uint256) {
        return connections[fromAgentId][toAgentId].strength;
    }
} 