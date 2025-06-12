require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const axios = require('axios');
const bodyParser = require('body-parser');

const app = express();
const server = http.createServer(app);

// WebSocket server
const wss = new WebSocket.Server({ server });

// Serve static files from public directory
app.use(express.static('public'));
app.use(bodyParser.json());

// Configuration
const config = {
    verifyToken: process.env.VERIFY_TOKEN || 'YOUR_VERIFY_TOKEN',
    accessToken: process.env.WHATSAPP_ACCESS_TOKEN,
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID,
    businessAccountId: process.env.WHATSAPP_BUSINESS_ACCOUNT_ID,
    apiVersion: 'v18.0'
};

// In-memory storage (replace with database in production)
const clients = new Map(); // WebSocket clients
const messages = new Map(); // contactId → message array
const contacts = new Map(); // contactId → contact info

// Webhook verification endpoint
app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode && token === config.verifyToken) {
        console.log('✅ Webhook verified');
        res.status(200).send(challenge);
    } else {
        console.log('❌ Webhook verification failed');
        res.sendStatus(403);
    }
});

// WhatsApp webhook endpoint
app.post('/webhook', (req, res) => {
    try {
        const body = req.body;
        
        if (body.object === 'whatsapp_business_account') {
            body.entry.forEach(entry => {
                entry.changes.forEach(change => {
                    if (change.field === 'messages') {
                        handleIncomingMessage(change.value);
                    }
                });
            });
        }
        
        res.status(200).send('EVENT_RECEIVED');
    } catch (error) {
        console.error('Webhook error:', error);
        res.status(500).send('Internal Server Error');
    }
});

// API endpoint to get messages
app.get('/api/messages/:contactId', (req, res) => {
    const contactId = req.params.contactId;
    res.json({
        messages: messages.get(contactId) || [],
        contact: contacts.get(contactId) || { id: contactId, name: contactId }
    });
});

// Handle incoming WhatsApp messages
function handleIncomingMessage(value) {
    try {
        const message = value.messages[0];
        const contact = value.contacts[0];
        const contactId = contact.wa_id;

        const msgData = {
            id: message.id,
            contactId: contactId,
            text: getMessageText(message),
            direction: 'incoming',
            timestamp: new Date(parseInt(message.timestamp) * 1000),
            status: 'delivered'
        };

        // Store contact info
        if (!contacts.has(contactId)) {
            contacts.set(contactId, {
                id: contactId,
                name: contact.profile.name,
                lastMessage: msgData.text,
                lastMessageTime: msgData.timestamp
            });
        }

        // Store message
        if (!messages.has(contactId)) {
            messages.set(contactId, []);
        }
        messages.get(contactId).push(msgData);

        // Update last message info
        const contactInfo = contacts.get(contactId);
        contactInfo.lastMessage = msgData.text;
        contactInfo.lastMessageTime = msgData.timestamp;

        // Broadcast to connected clients
        broadcast({
            type: 'message',
            message: msgData,
            contact: contactInfo
        });

        // Send read receipt
        markMessageAsRead(message.id);

    } catch (error) {
        console.error('Error handling incoming message:', error);
    }
}

function getMessageText(message) {
    if (message.text) return message.text.body;
    if (message.image) return '[Image]';
    if (message.video) return '[Video]';
    if (message.audio) return '[Audio]';
    if (message.document) return '[Document]';
    return '[Media message]';
}

// WebSocket connection handler
wss.on('connection', (ws) => {
    const clientId = Date.now().toString();
    clients.set(clientId, ws);
    console.log(`Client connected: ${clientId}`);

    // Send initial contacts
    ws.send(JSON.stringify({
        type: 'contacts',
        contacts: Array.from(contacts.values())
    }));

    // Handle client messages
    ws.on('message', (data) => {
        try {
            const message = JSON.parse(data);
            
            if (message.type === 'auth' && message.token === config.accessToken) {
                console.log(`Client ${clientId} authenticated`);
            } 
            else if (message.type === 'send_message') {
                handleClientMessage(message, clientId);
            }
        } catch (error) {
            console.error('WebSocket message error:', error);
        }
    });

    // Handle disconnection
    ws.on('close', () => {
        clients.delete(clientId);
        console.log(`Client disconnected: ${clientId}`);
    });
});

// Handle outgoing messages from client
async function handleClientMessage(data, clientId) {
    try {
        const { contactId, text } = data;
        
        // Create temporary message for UI
        const tempMsg = {
            id: `temp-${Date.now()}`,
            contactId,
            text,
            direction: 'outgoing',
            timestamp: new Date(),
            status: 'sending'
        };

        // Store temporarily
        if (!messages.has(contactId)) messages.set(contactId, []);
        messages.get(contactId).push(tempMsg);

        // Broadcast to all clients
        broadcast({
            type: 'message',
            message: tempMsg
        });

        // Send via WhatsApp API
        const response = await sendWhatsAppMessage(contactId, text);
        
        // Update with real message ID and status
        const realMsg = {
            ...tempMsg,
            id: response.messages[0].id,
            status: 'sent'
        };

        // Update in storage
        const contactMessages = messages.get(contactId);
        const msgIndex = contactMessages.findIndex(m => m.id === tempMsg.id);
        if (msgIndex !== -1) contactMessages[msgIndex] = realMsg;

        // Broadcast update
        broadcast({
            type: 'message',
            message: realMsg
        });

    } catch (error) {
        console.error('Error sending message:', error);
        const ws = clients.get(clientId);
        if (ws) {
            ws.send(JSON.stringify({
                type: 'error',
                message: 'Failed to send message'
            }));
        }
    }
}

// WhatsApp API functions
async function sendWhatsAppMessage(contactId, text) {
    const response = await axios.post(
        `https://graph.facebook.com/${config.apiVersion}/${config.phoneNumberId}/messages`,
        {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: contactId,
            type: 'text',
            text: { body: text }
        },
        {
            headers: {
                'Authorization': `Bearer ${config.accessToken}`,
                'Content-Type': 'application/json'
            }
        }
    );
    return response.data;
}

async function markMessageAsRead(messageId) {
    try {
        await axios.post(
            `https://graph.facebook.com/${config.apiVersion}/${config.phoneNumberId}/messages`,
            {
                messaging_product: 'whatsapp',
                status: 'read',
                message_id: messageId
            },
            {
                headers: {
                    'Authorization': `Bearer ${config.accessToken}`,
                    'Content-Type': 'application/json'
                }
            }
        );
    } catch (error) {
        console.error('Error marking message as read:', error.response?.data || error.message);
    }
}

// Broadcast to all connected clients
function broadcast(data) {
    const message = JSON.stringify(data);
    clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Webhook URL: ${process.env.NEXT_PUBLIC_APP_URL}/webhook`);
});