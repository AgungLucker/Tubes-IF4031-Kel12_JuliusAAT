function authenticateApiKey(req, res, next) {
//   const key = req.headers['x-bmkg-key'];

//   if (!key) {
//     return res.status(401).json({ error: 'Missing X-BMKG-Key header' });
//   }
  next(); 
}

module.exports = authenticateApiKey