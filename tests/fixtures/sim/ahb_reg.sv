// fig-gen test fixture (self-written): an AHB-Lite slave with four 32-bit
// registers at 0x0, 0x4, 0x8, 0xC; register 3 reads back register 0 plus 1.
module ahb_reg (
  input  logic        hclk,
  input  logic        hresetn,
  input  logic        hsel,
  input  logic [1:0]  htrans,
  input  logic        hwrite,
  input  logic [11:0] haddr,
  input  logic [31:0] hwdata,
  input  logic        hready,
  output logic [31:0] hrdata,
  output logic        hreadyout,
  output logic        hresp
);
  logic [31:0] r [0:2];
  logic        wr_q;
  logic [1:0]  idx_q;
  assign hreadyout = 1'b1;
  assign hresp     = 1'b0;
  always_ff @(posedge hclk or negedge hresetn) begin
    if (!hresetn) begin
      wr_q  <= 1'b0;
      idx_q <= 2'd0;
      r[0]  <= 32'd0;
      r[1]  <= 32'd0;
      r[2]  <= 32'd0;
    end else begin
      if (wr_q && idx_q != 2'd3) r[idx_q] <= hwdata;
      if (hsel && hready && htrans[1]) begin
        wr_q  <= hwrite;
        idx_q <= haddr[3:2];
      end else begin
        wr_q <= 1'b0;
      end
    end
  end
  assign hrdata = idx_q == 2'd3 ? r[0] + 32'd1 : r[idx_q];
endmodule
