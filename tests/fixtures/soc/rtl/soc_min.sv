// UNIT-TEST FIXTURE ONLY. Exercises fig-gen's own SoC cross-check code in
// `npm test`. It must never be used, copied, generated or referenced as
// evidence for a real figure; the evidence guard rejects it (evidence/self-authored).
// A CPU on an AHB-Lite system bus with SRAM, an accelerator slot and an
// AHB-to-APB bridge (two register peripherals). `cpu_core` is intentionally
// not defined anywhere: it exercises the generic blackbox path.

module soc_min_top #(
  parameter logic [31:0] SRAM_BASE = 32'h0000_0000,
  parameter logic [31:0] APB_BASE  = 32'h4000_0000,
  parameter logic [31:0] ACC_BASE  = 32'h5A00_0000
) (
  input  logic hclk,
  input  logic hresetn
);
  logic [31:0] haddr, hwdata, hrdata;
  logic [1:0]  htrans;
  logic        hwrite, hready;
  logic        hsel_sram, hsel_apb, hsel_acc;
  logic [31:0] hrdata_sram, hrdata_apb, hrdata_acc;
  logic        hready_sram, hready_apb, hready_acc;
  logic        acc_irq, uart_irq;
  logic [31:0] irq_vec;
  logic [11:0] paddr;
  logic [31:0] pwdata, prdata, prdata_uart, prdata_timer;
  logic        pwrite, penable, psel_uart, psel_timer;

  cpu_core u_cpu (
    .HCLK    (hclk),
    .HRESETn (hresetn),
    .HADDR   (haddr),
    .HTRANS  (htrans),
    .HWRITE  (hwrite),
    .HWDATA  (hwdata),
    .HRDATA  (hrdata),
    .HREADY  (hready),
    .IRQ     (irq_vec)
  );

  // Address decode (subordinate select) and response mux
  assign hsel_sram = haddr[31:16] == SRAM_BASE[31:16];
  assign hsel_apb  = haddr[31:28] == APB_BASE[31:28];
  assign hsel_acc  = haddr[31:12] == ACC_BASE[31:12];
  assign hrdata = hsel_acc ? hrdata_acc : (hsel_apb ? hrdata_apb : hrdata_sram);
  assign hready = hsel_acc ? hready_acc : (hsel_apb ? hready_apb : hready_sram);

  ahb_sram #(.ADDR_W(16)) u_sram (
    .hclk        (hclk),
    .hrst_n      (hresetn),
    .hsel_i      (hsel_sram),
    .htrans_i    (htrans),
    .hwrite_i    (hwrite),
    .haddr_i     (haddr[15:0]),
    .hwdata_i    (hwdata),
    .hrdata_o    (hrdata_sram),
    .hreadyout_o (hready_sram)
  );

  acc_slot u_acc (
    .hclk        (hclk),
    .hrst_n      (hresetn),
    .hsel_i      (hsel_acc),
    .htrans_i    (htrans),
    .hwrite_i    (hwrite),
    .haddr_i     (haddr[11:0]),
    .hwdata_i    (hwdata),
    .hrdata_o    (hrdata_acc),
    .hreadyout_o (hready_acc),
    .irq_o       (acc_irq)
  );

  ahb_to_apb u_br (
    .hclk         (hclk),
    .hrst_n       (hresetn),
    .hsel_i       (hsel_apb),
    .htrans_i     (htrans),
    .hwrite_i     (hwrite),
    .haddr_i      (haddr[15:0]),
    .hwdata_i     (hwdata),
    .hrdata_o     (hrdata_apb),
    .hreadyout_o  (hready_apb),
    .paddr_o      (paddr),
    .pwdata_o     (pwdata),
    .pwrite_o     (pwrite),
    .penable_o    (penable),
    .psel_uart_o  (psel_uart),
    .psel_timer_o (psel_timer),
    .prdata_i     (prdata)
  );

  assign prdata = psel_timer ? prdata_timer : prdata_uart;

  apb_reg_periph #(.IRQ_EN(1'b1)) u_uart (
    .pclk      (hclk),
    .prst_n    (hresetn),
    .psel_i    (psel_uart),
    .penable_i (penable),
    .pwrite_i  (pwrite),
    .paddr_i   (paddr),
    .pwdata_i  (pwdata),
    .prdata_o  (prdata_uart),
    .irq_o     (uart_irq)
  );

  apb_reg_periph #(.IRQ_EN(1'b0)) u_timer (
    .pclk      (hclk),
    .prst_n    (hresetn),
    .psel_i    (psel_timer),
    .penable_i (penable),
    .pwrite_i  (pwrite),
    .paddr_i   (paddr),
    .pwdata_i  (pwdata),
    .prdata_o  (prdata_timer),
    .irq_o     ()
  );

  // Interrupt vector: accelerator on line 21, UART on line 1
  assign irq_vec = {10'b0, acc_irq, 19'b0, uart_irq, 1'b0};
endmodule

module ahb_sram #(
  parameter int ADDR_W = 16,
  parameter int DEPTH  = 256
) (
  input  logic              hclk,
  input  logic              hrst_n,
  input  logic              hsel_i,
  input  logic [1:0]        htrans_i,
  input  logic              hwrite_i,
  input  logic [ADDR_W-1:0] haddr_i,
  input  logic [31:0]       hwdata_i,
  output logic [31:0]       hrdata_o,
  output logic              hreadyout_o
);
  logic [31:0]       mem [0:DEPTH-1];
  logic [ADDR_W-1:0] addr_q;
  logic              we_q;

  always_ff @(posedge hclk or negedge hrst_n) begin
    if (!hrst_n) begin
      addr_q <= '0;
      we_q   <= 1'b0;
    end else begin
      addr_q <= haddr_i;
      we_q   <= hsel_i & htrans_i[1] & hwrite_i;
    end
  end

  always_ff @(posedge hclk) begin
    if (we_q) mem[addr_q[9:2]] <= hwdata_i;
  end

  assign hrdata_o    = mem[addr_q[9:2]];
  assign hreadyout_o = 1'b1;
endmodule

module acc_slot (
  input  logic        hclk,
  input  logic        hrst_n,
  input  logic        hsel_i,
  input  logic [1:0]  htrans_i,
  input  logic        hwrite_i,
  input  logic [11:0] haddr_i,
  input  logic [31:0] hwdata_i,
  output logic [31:0] hrdata_o,
  output logic        hreadyout_o,
  output logic        irq_o
);
  logic [31:0] ctrl_q;
  logic        done_q, wr_q;
  logic [11:0] addr_q;

  always_ff @(posedge hclk or negedge hrst_n) begin
    if (!hrst_n) begin
      wr_q   <= 1'b0;
      addr_q <= '0;
    end else begin
      wr_q   <= hsel_i & htrans_i[1] & hwrite_i;
      addr_q <= haddr_i;
    end
  end

  always_ff @(posedge hclk or negedge hrst_n) begin
    if (!hrst_n) begin
      ctrl_q <= '0;
      done_q <= 1'b0;
    end else if (wr_q && addr_q == 12'h000) begin
      ctrl_q <= hwdata_i;
      done_q <= hwdata_i[0];
    end
  end

  assign hrdata_o    = ctrl_q;
  assign hreadyout_o = 1'b1;
  assign irq_o       = done_q & ctrl_q[1];
endmodule

module ahb_to_apb (
  input  logic        hclk,
  input  logic        hrst_n,
  input  logic        hsel_i,
  input  logic [1:0]  htrans_i,
  input  logic        hwrite_i,
  input  logic [15:0] haddr_i,
  input  logic [31:0] hwdata_i,
  output logic [31:0] hrdata_o,
  output logic        hreadyout_o,
  output logic [11:0] paddr_o,
  output logic [31:0] pwdata_o,
  output logic        pwrite_o,
  output logic        penable_o,
  output logic        psel_uart_o,
  output logic        psel_timer_o,
  input  logic [31:0] prdata_i
);
  logic        active_q, write_q;
  logic [15:0] addr_q;

  always_ff @(posedge hclk or negedge hrst_n) begin
    if (!hrst_n) begin
      active_q <= 1'b0;
      addr_q   <= '0;
      write_q  <= 1'b0;
    end else begin
      active_q <= hsel_i & htrans_i[1];
      addr_q   <= haddr_i;
      write_q  <= hwrite_i;
    end
  end

  assign paddr_o      = addr_q[11:0];
  assign pwdata_o     = hwdata_i;
  assign pwrite_o     = write_q;
  assign penable_o    = active_q;
  assign psel_uart_o  = active_q & (addr_q[15:12] == 4'h0);
  assign psel_timer_o = active_q & (addr_q[15:12] == 4'h1);
  assign hrdata_o     = prdata_i;
  assign hreadyout_o  = 1'b1;
endmodule

module apb_reg_periph #(
  parameter bit IRQ_EN = 1'b0
) (
  input  logic        pclk,
  input  logic        prst_n,
  input  logic        psel_i,
  input  logic        penable_i,
  input  logic        pwrite_i,
  input  logic [11:0] paddr_i,
  input  logic [31:0] pwdata_i,
  output logic [31:0] prdata_o,
  output logic        irq_o
);
  logic [31:0] reg_q;

  always_ff @(posedge pclk or negedge prst_n) begin
    if (!prst_n) reg_q <= '0;
    else if (psel_i && penable_i && pwrite_i && paddr_i == 12'h000) reg_q <= pwdata_i;
  end

  assign prdata_o = reg_q;
  assign irq_o    = IRQ_EN ? reg_q[0] : 1'b0;
endmodule
