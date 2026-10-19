// /proc/t2c_usbreg: dump the sunxi USB0 (MUSB) controller registers; write "connect" to set the
// soft-connect bit, "vbus" to force VBUS valid high in ISCR. Bench diagnostics for the T2C.
#include <linux/module.h>
#include <linux/proc_fs.h>
#include <linux/seq_file.h>
#include <linux/io.h>
#include <linux/uaccess.h>
#define BASE 0x05100000
static void __iomem *b;
static int show(struct seq_file *m, void *v)
{
	u8 power = readb(b + 0x40), devctl = readb(b + 0x41), vend0 = readb(b + 0x43);
	u32 iscr = readl(b + 0x400), phyctl = readl(b + 0x404);
	seq_printf(m, "POWER=%02x soft_connect=%u hs_en=%u hs_flag=%u reset_flag=%u suspend=%u\n", power, (power>>6)&1, (power>>5)&1, (power>>4)&1, (power>>3)&1, (power>>1)&1);
	seq_printf(m, "DEVCTL=%02x b_device=%u fs_dev=%u ls_dev=%u vbus=%u host_mode=%u host_req=%u session=%u\n", devctl, (devctl>>7)&1, (devctl>>6)&1, (devctl>>5)&1, (devctl>>3)&3, (devctl>>2)&1, (devctl>>1)&1, devctl&1);
	seq_printf(m, "VEND0=%02x\n", vend0);
	seq_printf(m, "ISCR=%08x vbus_valid_from_data=%u from_vbus=%u ext_id=%u ext_dm=%u ext_dp=%u merged_vbus=%u merged_id=%u id_pullup_en=%u dpdm_pullup_en=%u force_id=%u force_vbus=%u vbus_src=%u hosc_en=%u\n", iscr, (iscr>>30)&1, (iscr>>29)&1, (iscr>>28)&1, (iscr>>27)&1, (iscr>>26)&1, (iscr>>25)&1, (iscr>>24)&1, (iscr>>17)&1, (iscr>>16)&1, (iscr>>14)&3, (iscr>>12)&3, (iscr>>10)&3, (iscr>>7)&1);
	seq_printf(m, "PHYCTL=%08x\n", phyctl);
	return 0;
}
static int open_(struct inode *i, struct file *f) { return single_open(f, show, NULL); }
static ssize_t write_(struct file *f, const char __user *u, size_t n, loff_t *o)
{
	char buf[16] = {0};
	if (n >= sizeof(buf)) n = sizeof(buf) - 1;
	if (copy_from_user(buf, u, n)) return -EFAULT;
	if (!strncmp(buf, "connect", 7)) { writeb(readb(b + 0x40) | 0x40, b + 0x40); pr_info("t2c_usbreg: soft_connect set\n"); }
	else if (!strncmp(buf, "disconnect", 10)) { writeb(readb(b + 0x40) & ~0x40, b + 0x40); pr_info("t2c_usbreg: soft_connect cleared\n"); }
	else if (!strncmp(buf, "vbus", 4)) { u32 v = readl(b + 0x400); v &= ~(3u << 12); v |= (3u << 12); v &= ~((1u<<6)|(1u<<5)|(1u<<4)); writel(v, b + 0x400); pr_info("t2c_usbreg: ISCR force_vbus_valid=high\n"); }
	else if (!strncmp(buf, "pullup", 6)) { u32 v = readl(b + 0x400); v |= (1u << 16); v &= ~((1u<<6)|(1u<<5)|(1u<<4)); writel(v, b + 0x400); pr_info("t2c_usbreg: ISCR dpdm_pullup_en=1\n"); }
	return n;
}
static const struct file_operations fops = { .owner = THIS_MODULE, .open = open_, .read = seq_read, .llseek = seq_lseek, .release = single_release, .write = write_ };
static int __init init_(void)
{
	b = ioremap(BASE, 0x1000);
	if (!b) return -ENOMEM;
	if (!proc_create("t2c_usbreg", 0644, NULL, &fops)) { iounmap(b); return -ENOMEM; }
	pr_info("t2c_usbreg: /proc/t2c_usbreg ready (USB0 at %08x)\n", BASE);
	return 0;
}
module_init(init_);
MODULE_LICENSE("GPL");
