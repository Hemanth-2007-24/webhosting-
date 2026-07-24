const express = require('express');
const router = express.Router();
const buildController = require('../controllers/buildController');
const authMiddleware = require('../middleware/auth');

router.post('/trigger', authMiddleware, buildController.triggerBuild);
router.get('/:id/logs', authMiddleware, buildController.getBuildLogs);

module.exports = router;
