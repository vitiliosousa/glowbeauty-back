import Fastify from "fastify";
import { Prisma, PrismaClient } from "@prisma/client";
import {
  adminEmail,
  adminName,
  checkPassword,
  hashPassword,
  signToken,
  verifyToken,
} from "./auth.js";

const prisma = new PrismaClient();
const app = Fastify({ logger: true });

const PUBLIC = new Set(["/health", "/auth/login"]);
const CORS_ORIGINS = (process.env.CORS_ORIGIN || "http://localhost:3000")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.addHook("onRequest", async (req, reply) => {
  const origin = req.headers.origin;
  if (origin && CORS_ORIGINS.includes(origin)) {
    reply.header("Access-Control-Allow-Origin", origin);
    reply.header("Vary", "Origin");
    reply.header(
      "Access-Control-Allow-Headers",
      "Authorization, Content-Type"
    );
    reply.header(
      "Access-Control-Allow-Methods",
      "GET,POST,PATCH,DELETE,OPTIONS"
    );
  }

  if (req.method === "OPTIONS") {
    return reply.status(204).send();
  }

  const path = req.url.split("?")[0];
  if (PUBLIC.has(path)) return;

  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token || !verifyToken(token)) {
    return reply.status(401).send({ error: "Não autenticado." });
  }
});

type PaymentMethod = "dinheiro" | "emola" | "mpesa" | "transferencia";
type ExpenseCategory =
  | "transporte"
  | "embalagem"
  | "materia-prima"
  | "estoque"
  | "outros";

const toNum = (v: Prisma.Decimal | number) => Number(v);

function mapCategoryToDb(c: ExpenseCategory) {
  return c === "materia-prima" ? "materia_prima" : c;
}

function mapCategoryFromDb(c: string): ExpenseCategory {
  return c === "materia_prima" ? "materia-prima" : (c as ExpenseCategory);
}

async function getMeta() {
  return prisma.appMeta.upsert({
    where: { id: 1 },
    create: { id: 1 },
    update: {},
  });
}

async function currentProfile() {
  const meta = await getMeta();
  return {
    email: adminEmail(),
    name: meta.adminName?.trim() || adminName(),
  };
}

async function loadData() {
  const [products, stockEntries, sales, expenses, cashMovements, meta] =
    await Promise.all([
      prisma.product.findMany({ orderBy: { createdAt: "desc" } }),
      prisma.stockEntry.findMany({
        include: { product: true },
        orderBy: { createdAt: "desc" },
      }),
      prisma.sale.findMany({
        include: { items: true, payments: true },
        orderBy: { createdAt: "desc" },
      }),
      prisma.expense.findMany({ orderBy: { createdAt: "desc" } }),
      prisma.cashMovement.findMany({ orderBy: { createdAt: "desc" } }),
      getMeta(),
    ]);

  return {
    products: products.map((p) => ({
      id: p.id,
      code: p.code,
      name: p.name,
      brand: p.brand ?? undefined,
      cost: toNum(p.cost),
      price: toNum(p.price),
      stock: p.stock,
      createdAt: p.createdAt.toISOString(),
    })),
    stockEntries: stockEntries.map((e) => ({
      id: e.id,
      batchId: e.batchId,
      productId: e.productId,
      productName: e.product.name,
      productCode: e.product.code,
      quantity: e.quantity,
      expenseAmount: e.expenseAmount != null ? toNum(e.expenseAmount) : undefined,
      createdAt: e.createdAt.toISOString(),
    })),
    sales: sales.map((s) => ({
      id: s.id,
      customerName: s.customerName,
      customerPhone: s.customerPhone,
      total: toNum(s.total),
      createdAt: s.createdAt.toISOString(),
      items: s.items.map((i) => ({
        productId: i.productId,
        productName: i.productName,
        productCode: i.productCode,
        quantity: i.quantity,
        unitPrice: toNum(i.unitPrice),
        unitCost: toNum(i.unitCost),
      })),
      payments: s.payments.map((p) => ({
        id: p.id,
        amount: toNum(p.amount),
        method: p.method as PaymentMethod,
        note: p.note ?? undefined,
        createdAt: p.createdAt.toISOString(),
      })),
    })),
    expenses: expenses.map((e) => ({
      id: e.id,
      description: e.description,
      amount: toNum(e.amount),
      category: mapCategoryFromDb(e.category),
      date: e.date.toISOString().slice(0, 10),
      createdAt: e.createdAt.toISOString(),
      stockBatchId: e.stockBatchId ?? undefined,
    })),
    cashBalance: toNum(meta.cashBalance),
    cashMovements: cashMovements.map((m) => ({
      id: m.id,
      type: m.type,
      amount: toNum(m.amount),
      balanceAfter: toNum(m.balanceAfter),
      note: m.note ?? undefined,
      saleId: m.saleId ?? undefined,
      createdAt: m.createdAt.toISOString(),
    })),
    productCounter: meta.productCounter,
  };
}

app.get("/health", async () => ({ ok: true }));

app.post<{ Body: { email?: string; password?: string } }>(
  "/auth/login",
  async (req, reply) => {
    const email = req.body.email?.trim().toLowerCase() ?? "";
    const password = req.body.password ?? "";
    if (email !== adminEmail()) {
      return reply
        .status(401)
        .send({ error: "E-mail ou palavra-passe incorrectos." });
    }

    const meta = await getMeta();
    if (!checkPassword(password, meta.adminPasswordHash)) {
      return reply
        .status(401)
        .send({ error: "E-mail ou palavra-passe incorrectos." });
    }

    const profile = await currentProfile();
    return { token: signToken(email), profile };
  }
);

app.get("/auth/me", async () => currentProfile());

app.patch<{ Body: { name?: string } }>("/auth/profile", async (req, reply) => {
  const name = req.body.name?.trim() ?? "";
  if (!name) {
    return reply.status(400).send({ error: "Informe o nome." });
  }
  await prisma.appMeta.upsert({
    where: { id: 1 },
    create: { id: 1, adminName: name },
    update: { adminName: name },
  });
  return currentProfile();
});

app.post<{
  Body: { currentPassword?: string; newPassword?: string };
}>("/auth/password", async (req, reply) => {
  const currentPassword = req.body.currentPassword ?? "";
  const newPassword = req.body.newPassword ?? "";
  if (newPassword.length < 6) {
    return reply.status(400).send({
      error: "A nova palavra-passe deve ter pelo menos 6 caracteres.",
    });
  }

  const meta = await getMeta();
  if (!checkPassword(currentPassword, meta.adminPasswordHash)) {
    return reply
      .status(400)
      .send({ error: "A palavra-passe actual está incorrecta." });
  }

  await prisma.appMeta.upsert({
    where: { id: 1 },
    create: { id: 1, adminPasswordHash: hashPassword(newPassword) },
    update: { adminPasswordHash: hashPassword(newPassword) },
  });

  return { ok: true };
});

app.get("/data", async () => loadData());

app.post<{
  Body: { name: string; brand?: string; cost: number; price: number };
}>("/products", async (req, reply) => {
  const { name, brand, cost, price } = req.body;
  if (!name?.trim() || price <= 0) {
    return reply.status(400).send({ error: "name e price são obrigatórios" });
  }

  const meta = await prisma.appMeta.upsert({
    where: { id: 1 },
    create: { id: 1, productCounter: 1 },
    update: { productCounter: { increment: 1 } },
  });

  await prisma.product.create({
    data: {
      code: `BEL-${String(meta.productCounter).padStart(3, "0")}`,
      name: name.trim(),
      brand: brand?.trim() || null,
      cost,
      price,
    },
  });

  return loadData();
});

app.patch<{
  Params: { id: string };
  Body: { name: string; brand?: string; cost: number; price: number };
}>("/products/:id", async (req, reply) => {
  const { name, brand, cost, price } = req.body;
  try {
    await prisma.product.update({
      where: { id: req.params.id },
      data: {
        name: name.trim(),
        brand: brand?.trim() || null,
        cost,
        price,
      },
    });
  } catch {
    return reply.status(404).send({ error: "Produto não encontrado." });
  }
  return loadData();
});

app.delete<{ Params: { id: string } }>("/products/:id", async (req, reply) => {
  try {
    await prisma.product.delete({ where: { id: req.params.id } });
  } catch {
    return reply.status(404).send({ error: "Produto não encontrado." });
  }
  return loadData();
});

app.post<{
  Body: {
    items: { productId: string; quantity: number }[];
    expenseAmount?: number;
    expenseDescription?: string;
  };
}>("/stock/batches", async (req, reply) => {
  const validItems = (req.body.items ?? []).filter((i) => i.quantity > 0);
  if (validItems.length === 0) {
    return reply
      .status(400)
      .send({ error: "Adicione pelo menos um produto com quantidade." });
  }

  const products = await prisma.product.findMany({
    where: { id: { in: validItems.map((i) => i.productId) } },
  });
  if (products.length !== validItems.length) {
    return reply.status(400).send({ error: "Produto não encontrado." });
  }

  const batchId = crypto.randomUUID();
  const expenseAmount =
    req.body.expenseAmount && req.body.expenseAmount > 0
      ? req.body.expenseAmount
      : undefined;

  await prisma.$transaction(async (tx) => {
    for (const item of validItems) {
      await tx.stockEntry.create({
        data: {
          batchId,
          productId: item.productId,
          quantity: item.quantity,
          expenseAmount: expenseAmount ?? null,
        },
      });
      await tx.product.update({
        where: { id: item.productId },
        data: { stock: { increment: item.quantity } },
      });
    }

    if (expenseAmount) {
      await tx.expense.create({
        data: {
          description:
            req.body.expenseDescription?.trim() ||
            `Compra de estoque (${validItems.length} produto${validItems.length > 1 ? "s" : ""})`,
          amount: expenseAmount,
          category: "estoque",
          date: new Date(),
          stockBatchId: batchId,
        },
      });
    }
  });

  return loadData();
});

app.post<{
  Body: {
    customerName: string;
    customerPhone: string;
    items: { productId: string; quantity: number }[];
    initialPayment?: { amount: number; method: PaymentMethod; note?: string };
  };
}>("/sales", async (req, reply) => {
  const qtyByProduct = new Map<string, number>();
  for (const item of req.body.items ?? []) {
    if (item.quantity <= 0) {
      return reply.status(400).send({ error: "Quantidade inválida." });
    }
    qtyByProduct.set(
      item.productId,
      (qtyByProduct.get(item.productId) ?? 0) + item.quantity
    );
  }
  if (qtyByProduct.size === 0) {
    return reply.status(400).send({ error: "Adicione pelo menos um produto." });
  }

  const products = await prisma.product.findMany({
    where: { id: { in: [...qtyByProduct.keys()] } },
  });
  const byId = new Map(products.map((p) => [p.id, p]));

  const saleItems: {
    productId: string;
    productName: string;
    productCode: string;
    quantity: number;
    unitPrice: number;
    unitCost: number;
  }[] = [];

  for (const [productId, quantity] of qtyByProduct) {
    const product = byId.get(productId);
    if (!product) {
      return reply.status(400).send({ error: "Produto não encontrado." });
    }
    if (product.stock < quantity) {
      return reply.status(400).send({
        error: `Estoque insuficiente para ${product.name}. Disponível: ${product.stock}.`,
      });
    }
    saleItems.push({
      productId: product.id,
      productName: product.name,
      productCode: product.code,
      quantity,
      unitPrice: toNum(product.price),
      unitCost: toNum(product.cost),
    });
  }

  const total = saleItems.reduce(
    (sum, i) => sum + i.unitPrice * i.quantity,
    0
  );

  const pay = req.body.initialPayment;
  if (pay && pay.amount > 0 && pay.amount > total + 0.001) {
    return reply
      .status(400)
      .send({ error: "O valor pago não pode ser maior que o total da venda." });
  }

  const customerName = req.body.customerName?.trim() || "Cliente";

  await prisma.$transaction(async (tx) => {
    const sale = await tx.sale.create({
      data: {
        customerName,
        customerPhone: req.body.customerPhone?.trim() || "",
        total,
        items: { create: saleItems },
        payments:
          pay && pay.amount > 0
            ? {
                create: {
                  amount: pay.amount,
                  method: pay.method,
                  note: pay.note?.trim() || null,
                },
              }
            : undefined,
      },
    });

    for (const item of saleItems) {
      await tx.product.update({
        where: { id: item.productId },
        data: { stock: { decrement: item.quantity } },
      });
    }

    if (pay && pay.amount > 0 && pay.method === "dinheiro") {
      const meta = await tx.appMeta.upsert({
        where: { id: 1 },
        create: { id: 1, cashBalance: pay.amount },
        update: { cashBalance: { increment: pay.amount } },
      });
      await tx.cashMovement.create({
        data: {
          type: "venda",
          amount: pay.amount,
          balanceAfter: meta.cashBalance,
          note: `Venda — ${customerName}`,
          saleId: sale.id,
        },
      });
    }
  });

  return loadData();
});

app.post<{
  Params: { id: string };
  Body: { amount: number; method: PaymentMethod; note?: string };
}>("/sales/:id/payments", async (req, reply) => {
  const sale = await prisma.sale.findUnique({
    where: { id: req.params.id },
    include: { payments: true },
  });
  if (!sale) {
    return reply.status(404).send({ error: "Venda não encontrada." });
  }

  const paid = sale.payments.reduce((s, p) => s + toNum(p.amount), 0);
  const remaining = Math.max(0, toNum(sale.total) - paid);
  const { amount, method, note } = req.body;

  if (amount <= 0) {
    return reply.status(400).send({ error: "Informe um valor válido." });
  }
  if (amount > remaining + 0.001) {
    return reply.status(400).send({
      error: `Valor maior que o restante (${remaining.toFixed(2)} MT).`,
    });
  }

  await prisma.$transaction(async (tx) => {
    await tx.salePayment.create({
      data: {
        saleId: sale.id,
        amount,
        method,
        note: note?.trim() || null,
      },
    });

    if (method === "dinheiro") {
      const meta = await tx.appMeta.upsert({
        where: { id: 1 },
        create: { id: 1, cashBalance: amount },
        update: { cashBalance: { increment: amount } },
      });
      await tx.cashMovement.create({
        data: {
          type: "venda",
          amount,
          balanceAfter: meta.cashBalance,
          note: `Pagamento — ${sale.customerName}`,
          saleId: sale.id,
        },
      });
    }
  });

  return loadData();
});

app.post<{
  Body: {
    description: string;
    amount: number;
    category: ExpenseCategory;
    date: string;
  };
}>("/expenses", async (req) => {
  const { description, amount, category, date } = req.body;
  await prisma.expense.create({
    data: {
      description: description.trim(),
      amount,
      category: mapCategoryToDb(category),
      date: new Date(date),
    },
  });
  return loadData();
});

app.delete<{ Params: { id: string } }>("/expenses/:id", async (req, reply) => {
  try {
    await prisma.expense.delete({ where: { id: req.params.id } });
  } catch {
    return reply.status(404).send({ error: "Despesa não encontrada." });
  }
  return loadData();
});

app.post<{ Body: { amount: number; note?: string } }>(
  "/cash/entrada",
  async (req, reply) => {
    const { amount, note } = req.body;
    if (!Number.isFinite(amount) || amount <= 0) {
      return reply.status(400).send({ error: "Informe um valor válido." });
    }
    await prisma.$transaction(async (tx) => {
      const meta = await tx.appMeta.upsert({
        where: { id: 1 },
        create: { id: 1, cashBalance: amount },
        update: { cashBalance: { increment: amount } },
      });
      await tx.cashMovement.create({
        data: {
          type: "entrada",
          amount,
          balanceAfter: meta.cashBalance,
          note: note?.trim() || null,
        },
      });
    });
    return loadData();
  }
);

app.post<{ Body: { amount: number; note?: string } }>(
  "/cash/saida",
  async (req, reply) => {
    const { amount, note } = req.body;
    if (!Number.isFinite(amount) || amount <= 0) {
      return reply.status(400).send({ error: "Informe um valor válido." });
    }
    const meta = await getMeta();
    if (amount > toNum(meta.cashBalance) + 0.001) {
      return reply.status(400).send({
        error: `Saldo insuficiente. Disponível: ${toNum(meta.cashBalance).toFixed(2)} MT.`,
      });
    }
    await prisma.$transaction(async (tx) => {
      const updated = await tx.appMeta.update({
        where: { id: 1 },
        data: { cashBalance: { decrement: amount } },
      });
      await tx.cashMovement.create({
        data: {
          type: "saida",
          amount,
          balanceAfter: updated.cashBalance,
          note: note?.trim() || null,
        },
      });
    });
    return loadData();
  }
);

app.post<{ Body: { amount: number; note?: string } }>(
  "/cash/ajuste",
  async (req, reply) => {
    const { amount, note } = req.body;
    if (!Number.isFinite(amount) || amount < 0) {
      return reply.status(400).send({ error: "Informe um valor válido." });
    }
    await prisma.$transaction(async (tx) => {
      await tx.appMeta.upsert({
        where: { id: 1 },
        create: { id: 1, cashBalance: amount },
        update: { cashBalance: amount },
      });
      await tx.cashMovement.create({
        data: {
          type: "ajuste",
          amount,
          balanceAfter: amount,
          note: note?.trim() || "Saldo actualizado",
        },
      });
    });
    return loadData();
  }
);

const port = Number(process.env.PORT) || 3333;

app
  .listen({ port, host: "0.0.0.0" })
  .then(() => console.log(`API em http://localhost:${port}`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
