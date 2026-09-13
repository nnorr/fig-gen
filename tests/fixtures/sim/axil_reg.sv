// fig-gen test fixture (self-written): an AXI4-Lite slave with two registers
// at 0x0 and 0x4; write accepts AW and W together, read answers one cycle later.
module axil_reg (
  input  logic        aclk,
  input  logic        aresetn,
  input  logic        awvalid,
  output logic        awready,
  input  logic [7:0]  awaddr,
  input  logic        wvalid,
  output logic        wready,
  input  logic [31:0] wdata,
  output logic        bvalid,
  input  logic        bready,
  output logic [1:0]  bresp,
  input  logic        arvalid,
  output logic        arready,
  input  logic [7:0]  araddr,
  output logic        rvalid,
  input  logic        rready,
  output logic [31:0] rdata,
  output logic [1:0]  rresp
);
  logic [31:0] r0, r1;
  assign awready = !bvalid && awvalid && wvalid;
  assign wready  = awready;
  assign arready = !rvalid;
  assign bresp   = 2'b00;
  assign rresp   = 2'b00;
  always_ff @(posedge aclk or negedge aresetn) begin
    if (!aresetn) begin
      r0 <= 32'd0;
      r1 <= 32'd0;
      bvalid <= 1'b0;
      rvalid <= 1'b0;
      rdata <= 32'd0;
    end else begin
      if (awready) begin
        if (awaddr[2]) r1 <= wdata;
        else r0 <= wdata;
        bvalid <= 1'b1;
      end else if (bvalid && bready) bvalid <= 1'b0;
      if (arvalid && arready) begin
        rvalid <= 1'b1;
        rdata  <= araddr[2] ? r1 : r0;
      end else if (rvalid && rready) rvalid <= 1'b0;
    end
  end
endmodule
