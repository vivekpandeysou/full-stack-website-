const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.use('/uploads', express.static('uploads'));

// ============================================================
// DATABASE CONNECTION
// ============================================================
mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/german-bakers')
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('❌ MongoDB error:', err));

// ============================================================
// SCHEMAS
// ============================================================
const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  role: { type: String, default: 'admin' }
});

const menuItemSchema = new mongoose.Schema({
  name: { type: String, required: true },
  category: { type: String, required: true, enum: ['Cakes', 'Others', 'Shakes & Coolers', 'Salad'] },
  price: { type: Number, required: true },
  description: String,
  emoji: { type: String, default: '🎂' },
  image: String,
  customizable: { type: Boolean, default: false },
  available: { type: Boolean, default: true }
}, { timestamps: true });

const couponSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true, uppercase: true },
  discount: { type: Number, required: true },
  type: { type: String, enum: ['percent', 'flat'], default: 'percent' },
  active: { type: Boolean, default: true },
  minOrder: { type: Number, default: 0 }
}, { timestamps: true });

const orderSchema = new mongoose.Schema({
  orderId: { type: String, unique: true },
  items: [{
    itemId: mongoose.Schema.Types.ObjectId,
    name: String,
    price: Number,
    qty: Number,
    emoji: String
  }],
  subtotal: Number,
  delivery: Number,
  discount: Number,
  total: Number,
  payment: { type: String, enum: ['cod', 'upi'] },
  couponUsed: String,
  status: { type: String, enum: ['new', 'processing', 'delivered', 'cancelled'], default: 'new' },
  customerPhone: String,
  customerAddress: String
}, { timestamps: true });

const settingsSchema = new mongoose.Schema({
  key: { type: String, unique: true },
  value: mongoose.Schema.Types.Mixed
});

const User = mongoose.model('User', userSchema);
const MenuItem = mongoose.model('MenuItem', menuItemSchema);
const Coupon = mongoose.model('Coupon', couponSchema);
const Order = mongoose.model('Order', orderSchema);
const Settings = mongoose.model('Settings', settingsSchema);

// ============================================================
// MIDDLEWARE
// ============================================================
const authMiddleware = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token provided' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET || 'german_bakers_secret');
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
};

// ============================================================
// FILE UPLOAD
// ============================================================
const storage = multer.diskStorage({
  destination: 'uploads/',
  filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });

// ============================================================
// AUTH ROUTES
// ============================================================
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await User.findOne({ username });
    if (!user || !await bcrypt.compare(password, user.password)) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const token = jwt.sign({ id: user._id, role: user.role }, process.env.JWT_SECRET || 'german_bakers_secret', { expiresIn: '24h' });
    res.json({ token, user: { username: user.username, role: user.role } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// MENU ROUTES
// ============================================================
app.get('/api/menu', async (req, res) => {
  try {
    const { category, search } = req.query;
    let query = { available: true };
    if (category) query.category = category;
    if (search) query.name = { $regex: search, $options: 'i' };
    const items = await MenuItem.find(query).sort({ category: 1, name: 1 });
    res.json(items);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/menu/:id', async (req, res) => {
  try {
    const item = await MenuItem.findById(req.params.id);
    if (!item) return res.status(404).json({ error: 'Item not found' });
    res.json(item);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/menu', authMiddleware, upload.single('image'), async (req, res) => {
  try {
    const data = { ...req.body };
    if (req.file) data.image = '/uploads/' + req.file.filename;
    const item = new MenuItem(data);
    await item.save();
    res.status(201).json(item);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/menu/:id', authMiddleware, upload.single('image'), async (req, res) => {
  try {
    const data = { ...req.body };
    if (req.file) data.image = '/uploads/' + req.file.filename;
    const item = await MenuItem.findByIdAndUpdate(req.params.id, data, { new: true });
    if (!item) return res.status(404).json({ error: 'Item not found' });
    res.json(item);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/menu/:id', authMiddleware, async (req, res) => {
  try {
    await MenuItem.findByIdAndDelete(req.params.id);
    res.json({ message: 'Item deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// ORDER ROUTES
// ============================================================
app.post('/api/orders', async (req, res) => {
  try {
    const { items, payment, couponCode, customerPhone, customerAddress } = req.body;
    const settings_cod = await Settings.findOne({ key: 'delivery_cod' });
    const settings_upi = await Settings.findOne({ key: 'delivery_upi' });
    const codCharge = settings_cod?.value || 50;
    const upiCharge = settings_upi?.value || 0;
    const delivery = payment === 'cod' ? codCharge : upiCharge;

    const subtotal = items.reduce((sum, i) => sum + i.price * i.qty, 0);
    let discount = 0;
    let couponUsed = null;

    if (couponCode) {
      const coupon = await Coupon.findOne({ code: couponCode.toUpperCase(), active: true });
      if (coupon && subtotal >= coupon.minOrder) {
        discount = coupon.type === 'percent' ? Math.round(subtotal * coupon.discount / 100) : coupon.discount;
        couponUsed = coupon.code;
      }
    }

    const total = Math.max(0, subtotal + delivery - discount);
    const orderId = 'GB-' + Date.now().toString().slice(-6);

    const order = new Order({ orderId, items, subtotal, delivery, discount, total, payment, couponUsed, customerPhone, customerAddress });
    await order.save();

    res.status(201).json({ order, message: 'Order placed successfully!' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/orders', authMiddleware, async (req, res) => {
  try {
    const orders = await Order.find().sort({ createdAt: -1 });
    res.json(orders);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/orders/:id/status', authMiddleware, async (req, res) => {
  try {
    const order = await Order.findByIdAndUpdate(req.params.id, { status: req.body.status }, { new: true });
    res.json(order);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ============================================================
// COUPON ROUTES
// ============================================================
app.post('/api/coupons/validate', async (req, res) => {
  try {
    const { code, total } = req.body;
    const coupon = await Coupon.findOne({ code: code.toUpperCase(), active: true });
    if (!coupon) return res.status(404).json({ error: 'Invalid or expired coupon' });
    if (total < coupon.minOrder) return res.status(400).json({ error: `Minimum order ₹${coupon.minOrder} required` });
    res.json({ valid: true, coupon });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/coupons', authMiddleware, async (req, res) => {
  try {
    const coupons = await Coupon.find().sort({ createdAt: -1 });
    res.json(coupons);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/coupons', authMiddleware, async (req, res) => {
  try {
    const coupon = new Coupon(req.body);
    await coupon.save();
    res.status(201).json(coupon);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/coupons/:id', authMiddleware, async (req, res) => {
  try {
    const coupon = await Coupon.findByIdAndUpdate(req.params.id, req.body, { new: true });
    res.json(coupon);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/coupons/:id', authMiddleware, async (req, res) => {
  try {
    await Coupon.findByIdAndDelete(req.params.id);
    res.json({ message: 'Coupon deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// SETTINGS ROUTES
// ============================================================
app.get('/api/settings', async (req, res) => {
  try {
    const settings = await Settings.find();
    const result = {};
    settings.forEach(s => result[s.key] = s.value);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/settings', authMiddleware, async (req, res) => {
  try {
    const updates = Object.entries(req.body);
    for (const [key, value] of updates) {
      await Settings.findOneAndUpdate({ key }, { value }, { upsert: true });
    }
    res.json({ message: 'Settings updated' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ============================================================
// ADMIN STATS
// ============================================================
app.get('/api/admin/stats', authMiddleware, async (req, res) => {
  try {
    const [orderCount, menuCount, activeCoupons, orders] = await Promise.all([
      Order.countDocuments(),
      MenuItem.countDocuments({ available: true }),
      Coupon.countDocuments({ active: true }),
      Order.find({}, 'total status')
    ]);
    const revenue = orders.reduce((sum, o) => sum + o.total, 0);
    const statusCounts = { new: 0, processing: 0, delivered: 0, cancelled: 0 };
    orders.forEach(o => statusCounts[o.status]++);
    res.json({ orderCount, menuCount, activeCoupons, revenue, statusCounts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// SEED DATA & SERVER START
// ============================================================
async function seedDatabase() {
  const adminExists = await User.findOne({ username: 'admin' });
  if (!adminExists) {
    const hashed = await bcrypt.hash('german123', 10);
    await User.create({ username: 'admin', password: hashed, role: 'admin' });
    console.log('✅ Admin user created: admin / german123');
  }

  const itemCount = await MenuItem.countDocuments();
  if (itemCount === 0) {
    const seedItems = [
      { name: 'Truffle Cake', category: 'Cakes', price: 470, emoji: '🍫', description: 'Rich chocolate truffle with velvety ganache layers', customizable: true },
      { name: 'Rasmalai Cake', category: 'Cakes', price: 450, emoji: '🎂', description: 'Indian-fusion cake with rasmalai cream and saffron', customizable: true },
      { name: 'Kit Kat Cake', category: 'Cakes', price: 550, emoji: '🍫', description: 'Decadent chocolate cake wrapped in Kit Kat fingers', customizable: true },
      { name: 'Black Forest', category: 'Cakes', price: 350, emoji: '🍒', description: 'Traditional German Schwarzwälder with cherries', customizable: true },
      { name: 'Chocolate Shake', category: 'Shakes & Coolers', price: 150, emoji: '🍫', description: 'Thick chocolate milkshake with chocolate sauce' },
      { name: 'Mango Shake', category: 'Shakes & Coolers', price: 139, emoji: '🥭', description: 'Fresh Alphonso mango blended to perfection' },
      { name: 'Swiss Roll', category: 'Others', price: 35, emoji: '🌀', description: 'A soft, tender cake rolled with a smooth filling' },
      { name: 'Truffle Ball', category: 'Others', price: 30, emoji: '⚫', description: 'Handrolled dark chocolate truffle, dusted with cocoa' },
      { name: 'Green Salad', category: 'Salad', price: 109, emoji: '🥗', description: 'Fresh seasonal greens with house vinaigrette' },
    ];
    await MenuItem.insertMany(seedItems);
    console.log('✅ Menu items seeded');
  }

  const couponCount = await Coupon.countDocuments();
  if (couponCount === 0) {
    await Coupon.insertMany([
      { code: 'GERMAN10', discount: 10, type: 'percent', active: true },
      { code: 'GERMAN20', discount: 20, type: 'percent', active: true },
      { code: 'FIRSTBITE', discount: 50, type: 'flat', active: true }
    ]);
    console.log('✅ Coupons seeded');
  }

  await Settings.findOneAndUpdate({ key: 'delivery_cod' }, { value: 50 }, { upsert: true });
  await Settings.findOneAndUpdate({ key: 'delivery_upi' }, { value: 0 }, { upsert: true });
}

const PORT = process.env.PORT || 5000;
app.listen(PORT, async () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  await seedDatabase();
});
